import { kothEvents, type Database } from "@factions/db";
import {
  KOTH_GLOBALS, KOTH_LOCATIONS, KOTH_PRESET_FILES, KOTH_PRESET_PREFIX, kothLocation, kothWanted, restoredPresets,
} from "@factions/domain";
import { and, desc, eq, isNotNull, sql } from "drizzle-orm";
import { readSpawnGearPresets } from "./cfggameplay.js";
import { readGlobalVar, setGlobalVar } from "./globals-xml.js";
import { narrowFreshSpawns } from "./spawn-points.js";
import type { RestartTarget } from "./restart-tick.js";

export type KothRow = typeof kothEvents.$inferSelect;
type FileEdit = { dir: string; name: string; content: string };

export type KothPlan = {
  /** The row this slot opens, or null for the default. */
  opening: KothRow | null;
  /** The wanted preset list, or null to leave cfggameplay.json's list alone. */
  presets: string[] | null;
  /** Files to converge (only the ones that differ from the target). */
  files: FileEdit[];
  /** Why an opening was refused (already recorded on the row), or null. */
  failure: string | null;
};

const GAMEPLAY = "cfggameplay.json";
const GLOBALS = "globals.xml";
const SPAWNS = "cfgplayerspawnpoints.xml";
const isKoth = (p: string) => p.includes(`/${KOTH_PRESET_PREFIX}`);

async function readNonEmpty(nitrado: RestartTarget, path: string): Promise<string> {
  // ⚠️ The path goes into the message ourselves: it lands in the row's `detail`
  // and the ops alert, and an operator told only "404" cannot tell which file
  // to put back.
  const body = await nitrado.downloadFile(path).catch((err: unknown) => {
    throw new Error(`${path} could not be read (${err instanceof Error ? err.message : String(err)})`);
  });
  // ⚠️ An empty download is a missing file with a friendlier face; uploading it
  // over a live spawn file would leave a server nobody can spawn on.
  if (body.trim() === "") throw new Error(`${path} is empty`);
  return body;
}

/**
 * db/globals.xml with every `KOTH_GLOBALS` var set to `wanted(name)`, as an edit —
 * or none when the live file already carries those values. A splice of the live
 * file, never a whole-file copy: globals.xml holds far more than these vars.
 */
async function globalsEdit(nitrado: RestartTarget, dbDir: string, wanted: (name: string) => number): Promise<FileEdit[]> {
  const live = await readNonEmpty(nitrado, `${dbDir}/${GLOBALS}`);
  let next = live;
  for (const name of Object.keys(KOTH_GLOBALS)) next = setGlobalVar(next, name, wanted(name)).xml;
  return next === live ? [] : [{ dir: dbDir, name: GLOBALS, content: next }];
}

/**
 * What King of the Hill wants from this slot (spec 2026-10-07-koth-chernarus §3).
 * Null when no KotH row has EVER existed — the only case the restore arm may skip.
 *
 * ⚠️ Not gated on KOTH_TICK by the caller: switching the feature off mid-event
 * must still put the server back. `allowOpen` gates the OPENING branch alone.
 *
 * ⚠️ The opening is verified BEFORE anything is written, and a refusal returns
 * the RESTORE plan: a KotH we could not reverse is worse than one that never
 * starts, and a half-written open from an earlier failed attempt is undone the
 * same way.
 */
export async function planKoth(
  db: Database, nitrado: RestartTarget, serverId: number, slot: Date, opts: { allowOpen: boolean },
): Promise<KothPlan | null> {
  // ⚠️ FIRST, before any Nitrado call: a server that has never had a KotH row
  // must cost the restart tick nothing.
  const [any] = await db.select({ id: kothEvents.id }).from(kothEvents).where(eq(kothEvents.serverId, serverId)).limit(1);
  if (!any) return null;

  const root = await nitrado.missionRootDir();
  const dbDir = await nitrado.missionDbDir();
  const candidates = await db.select().from(kothEvents)
    .where(and(eq(kothEvents.serverId, serverId), eq(kothEvents.state, "scheduled")));
  const opening = opts.allowOpen ? kothWanted(slot, candidates) : null;

  let failure: string | null = null;
  if (opening) {
    try {
      // ⚠️ A row scheduled before the move to Chernarus names a Livonia town:
      // refused here with a reason, never a throw out of planKoth.
      const loc = kothLocation(opening.location);
      if (!loc) throw new Error(`${opening.location} is not one of the ${KOTH_LOCATIONS.length} KotH towns on this map`);
      const custom = new Set(await nitrado.listFiles(`${root}/custom`));
      const missing = KOTH_PRESET_FILES.filter((p) => !custom.has(p.slice("./custom/".length)));
      if (missing.length > 0) throw new Error(`KotH preset(s) missing on the server: ${missing.slice(0, 3).join(", ")}${missing.length > 3 ? " …" : ""}`);
      // The default is both the source of the session file and the restore target,
      // so reading it proves both.
      const spawns = narrowFreshSpawns(await readNonEmpty(nitrado, `${root}/koth/default/${SPAWNS}`), loc.spawnGroup);
      // ⚠️ The default is proved readable, var by var, BEFORE the session opens:
      // without it the restore could never put the cleanup values back.
      const globalsDefault = await readNonEmpty(nitrado, `${root}/koth/default/${GLOBALS}`);
      for (const name of Object.keys(KOTH_GLOBALS)) readGlobalVar(globalsDefault, name);
      const globals = await globalsEdit(nitrado, dbDir, (name) => KOTH_GLOBALS[name]!);
      // Snapshot BEFORE any upload. Read-only here; the single upload of
      // cfggameplay.json stays in applyGameplay.
      const presetsNow = readSpawnGearPresets(await nitrado.downloadFile(`${root}/${GAMEPLAY}`));
      // ⚠️ Only from a list with no koth- entry: a retried open after a partial
      // upload would otherwise record KotH's own list as the default.
      if (opening.loadoutSnapshot === null && !presetsNow.some(isKoth)) {
        await db.update(kothEvents).set({ loadoutSnapshot: presetsNow }).where(eq(kothEvents.id, opening.id));
      }
      return {
        opening, presets: [...KOTH_PRESET_FILES],
        files: [...await differing(nitrado, [{ dir: root, name: SPAWNS, content: spawns }]), ...globals], failure: null,
      };
    } catch (err) {
      failure = err instanceof Error ? err.message : String(err);
      await db.update(kothEvents).set({
        state: "failed",
        detail: sql`${kothEvents.detail} || ${JSON.stringify({ failure })}::jsonb`,
      }).where(and(eq(kothEvents.id, opening.id), eq(kothEvents.state, "scheduled")));
      console.error(`koth: server ${serverId} REFUSED to open ${opening.location} for ${slot.toISOString()} — ${failure}`);
    }
  }

  // ── Restore ──────────────────────────────────────────────────────────────
  const [latest] = await db.select().from(kothEvents)
    .where(and(eq(kothEvents.serverId, serverId), isNotNull(kothEvents.loadoutSnapshot)))
    .orderBy(desc(kothEvents.slotAt)).limit(1);
  const presetsNow = readSpawnGearPresets(await nitrado.downloadFile(`${root}/${GAMEPLAY}`));
  const problems: string[] = [];
  let presets: string[] | null;
  try {
    presets = restoredPresets(presetsNow, latest?.loadoutSnapshot ?? null);
  } catch (err) {
    // ⚠️ An empty restore leaves ONLY the preset list alone; the files still restore.
    presets = null;
    problems.push(err instanceof Error ? err.message : String(err));
  }

  let spawns: FileEdit[] = [];
  try {
    spawns = await differing(nitrado, [{ dir: root, name: SPAWNS, content: await readNonEmpty(nitrado, `${root}/koth/default/${SPAWNS}`) }]);
  } catch (err) {
    // ⚠️ Skip, never blank: a missing default must not become an empty spawn file.
    problems.push(err instanceof Error ? err.message : String(err));
  }
  let globals: FileEdit[] = [];
  try {
    const globalsDefault = await readNonEmpty(nitrado, `${root}/koth/default/${GLOBALS}`);
    globals = await globalsEdit(nitrado, dbDir, (name) => readGlobalVar(globalsDefault, name));
  } catch (err) {
    // ⚠️ Skip, never guess: a default we cannot read leaves the live values alone.
    problems.push(err instanceof Error ? err.message : String(err));
  }
  // ⚠️ One write for every restore problem this slot: two separate `||` merges of
  // the same `restoreError` key would leave only whichever landed last.
  if (problems.length > 0) {
    const [newest] = await db.select({ id: kothEvents.id }).from(kothEvents).where(eq(kothEvents.serverId, serverId)).orderBy(desc(kothEvents.slotAt)).limit(1);
    if (newest) await db.update(kothEvents).set({ detail: sql`${kothEvents.detail} || ${JSON.stringify({ restoreError: problems.join("; ") })}::jsonb` }).where(eq(kothEvents.id, newest.id));
    console.error(`koth: server ${serverId} could not restore everything — ${problems.join("; ")}`);
  }

  return { opening: null, presets, files: [...spawns, ...globals], failure };
}

/** Only the edits whose target currently differs. A missing target counts as differing. */
async function differing(nitrado: RestartTarget, edits: FileEdit[]): Promise<FileEdit[]> {
  const out: FileEdit[] = [];
  for (const e of edits) {
    const now = await nitrado.downloadFile(`${e.dir}/${e.name}`).catch(() => null);
    if (now !== e.content) out.push(e);
  }
  return out;
}

/**
 * Upload each edit. Each is independent: one failed upload does not stop the rest.
 * The list is `planKoth`'s, which has already dropped every file that matches its
 * target.
 */
export async function convergeKothFiles(nitrado: RestartTarget, files: FileEdit[]): Promise<{ uploaded: number; errors: string[] }> {
  let uploaded = 0;
  const errors: string[] = [];
  for (const f of files) {
    try {
      await nitrado.uploadFile(f.dir, f.name, f.content);
      uploaded += 1;
    } catch (err) {
      errors.push(`${f.dir}/${f.name}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  return { uploaded, errors };
}
