import { kothEvents, type Database } from "@factions/db";
import {
  KOTH_INFECTED_EVENTS, KOTH_PRESET_FILES, KOTH_PRESET_PREFIX, KOTH_WHOLE_FILES,
  kothWanted, restoredPresets,
} from "@factions/domain";
import { and, desc, eq, isNotNull, isNull, sql } from "drizzle-orm";
import { readSpawnGearPresets } from "./cfggameplay.js";
import { readEventActive } from "./events-xml.js";
import type { RestartTarget } from "./restart-tick.js";

export type KothRow = typeof kothEvents.$inferSelect;
type FileEdit = { dir: string; name: string; content: string };

export type KothPlan = {
  /** The row this slot opens, or null for the default. */
  opening: KothRow | null;
  /** The wanted preset list, or null to leave cfggameplay.json's list alone. */
  presets: string[] | null;
  /** The wanted infected `<active>` values, or null to leave events.xml alone. */
  infected: Record<string, 0 | 1> | null;
  /** The row whose `restored_at` to stamp once `infected` has uploaded. */
  infectedRestoreRowId: number | null;
  /** Whole files to converge (only the ones that differ from the target). */
  files: FileEdit[];
  /** Why an opening was refused (already recorded on the row), or null. */
  failure: string | null;
};

const GAMEPLAY = "cfggameplay.json";
const EVENTS = "events.xml";
const isKoth = (p: string) => p.includes(`/${KOTH_PRESET_PREFIX}`);

function targetDir(root: string, dir: "root" | "env"): string {
  return dir === "root" ? root : `${root}/env`;
}

async function readNonEmpty(nitrado: RestartTarget, path: string): Promise<string> {
  // ⚠️ The path goes into the message ourselves: it lands in the row's `detail`
  // and the ops alert, and an operator told only "404" cannot tell which of the
  // eight files to put back.
  const body = await nitrado.downloadFile(path).catch((err: unknown) => {
    throw new Error(`${path} could not be read (${err instanceof Error ? err.message : String(err)})`);
  });
  // ⚠️ An empty download is a missing file with a friendlier face; uploading it
  // over a live spawn file would leave a server nobody can spawn on.
  if (body.trim() === "") throw new Error(`${path} is empty`);
  return body;
}

/**
 * What King of the Hill wants from this slot (spec §5). Null when no KotH row
 * has EVER existed — the only case the restore arm may skip entirely.
 *
 * ⚠️ Not gated on KOTH_TICK by the caller: switching the feature off
 * mid-event must still put the server back (spec §5.3).
 *
 * ⚠️ The opening is verified BEFORE anything is written, and a refusal returns
 * the RESTORE plan: a KotH we could not reverse is worse than one that never
 * starts (§5.1), and a half-written open from an earlier failed attempt is
 * undone the same way.
 */
export async function planKoth(db: Database, nitrado: RestartTarget, serverId: number, slot: Date): Promise<KothPlan | null> {
  // ⚠️ FIRST, before any Nitrado call: a server that has never had a KotH row
  // must cost the restart tick nothing — not a single download (restart-tick.test.ts's
  // throwing fake holds this).
  const [any] = await db.select({ id: kothEvents.id }).from(kothEvents).where(eq(kothEvents.serverId, serverId)).limit(1);
  if (!any) return null;

  const root = await nitrado.missionRootDir();
  const dbDir = await nitrado.missionDbDir();
  const candidates = await db.select().from(kothEvents)
    .where(and(eq(kothEvents.serverId, serverId), eq(kothEvents.state, "scheduled")));
  const opening = kothWanted(slot, candidates);

  let failure: string | null = null;
  if (opening) {
    try {
      const custom = new Set(await nitrado.listFiles(`${root}/custom`));
      const missing = KOTH_PRESET_FILES.filter((p) => !custom.has(p.slice("./custom/".length)));
      if (missing.length > 0) throw new Error(`KotH preset(s) missing on the server: ${missing.slice(0, 3).join(", ")}${missing.length > 3 ? " …" : ""}`);
      const town: FileEdit[] = [];
      for (const f of KOTH_WHOLE_FILES) {
        await readNonEmpty(nitrado, `${root}/koth/default/${f.name}`);
        town.push({ dir: targetDir(root, f.dir), name: f.name, content: await readNonEmpty(nitrado, `${root}/koth/locations/${opening.location}/${f.name}`) });
      }
      // Snapshots, BEFORE any upload (spec §2.5). Read-only downloads here; the
      // single upload of each file stays in applyGameplay/applyEvents.
      const presetsNow = readSpawnGearPresets(await nitrado.downloadFile(`${root}/${GAMEPLAY}`));
      const eventsNow = await nitrado.downloadFile(`${dbDir}/${EVENTS}`);
      const infectedNow = Object.fromEntries(KOTH_INFECTED_EVENTS.map((n) => [n, readEventActive(eventsNow, n)])) as Record<string, 0 | 1>;
      await db.update(kothEvents).set({
        // ⚠️ Only from a list with no koth- entry: a retried open after a partial
        // upload would otherwise record KotH's own list as the default.
        ...(opening.loadoutSnapshot === null && !presetsNow.some(isKoth) ? { loadoutSnapshot: presetsNow } : {}),
        ...(opening.infectedSnapshot === null ? { infectedSnapshot: infectedNow } : {}),
      }).where(eq(kothEvents.id, opening.id));
      return {
        opening, presets: [...KOTH_PRESET_FILES],
        infected: Object.fromEntries(KOTH_INFECTED_EVENTS.map((n) => [n, 1])) as Record<string, 0 | 1>,
        infectedRestoreRowId: null, files: await differing(nitrado, town), failure: null,
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
    // ⚠️ Spec §5.3: an empty restore leaves ONLY the preset list alone. Letting this
    // throw out of planKoth skipped the infected and whole-file restores with it,
    // at every slot, for as long as the koth-only list stayed on the server.
    presets = null;
    problems.push(err instanceof Error ? err.message : String(err));
  }

  const [unrestored] = await db.select().from(kothEvents).where(and(
    eq(kothEvents.serverId, serverId), isNotNull(kothEvents.infectedSnapshot), isNull(kothEvents.restoredAt),
  )).orderBy(desc(kothEvents.slotAt)).limit(1);

  const defaults: FileEdit[] = [];
  for (const f of KOTH_WHOLE_FILES) {
    try {
      defaults.push({ dir: targetDir(root, f.dir), name: f.name, content: await readNonEmpty(nitrado, `${root}/koth/default/${f.name}`) });
    } catch (err) {
      // ⚠️ Skip, never blank: a missing default must not become an empty spawn file.
      problems.push(err instanceof Error ? err.message : String(err));
    }
  }
  // ⚠️ One write for every restore problem this slot: two separate `||` merges of
  // the same `restoreError` key would leave only whichever landed last.
  if (problems.length > 0) {
    const [newest] = await db.select({ id: kothEvents.id }).from(kothEvents).where(eq(kothEvents.serverId, serverId)).orderBy(desc(kothEvents.slotAt)).limit(1);
    if (newest) await db.update(kothEvents).set({ detail: sql`${kothEvents.detail} || ${JSON.stringify({ restoreError: problems.join("; ") })}::jsonb` }).where(eq(kothEvents.id, newest.id));
    console.error(`koth: server ${serverId} could not restore everything — ${problems.join("; ")}`);
  }

  return {
    opening: null, presets,
    infected: unrestored?.infectedSnapshot ?? null,
    infectedRestoreRowId: unrestored?.id ?? null,
    files: await differing(nitrado, defaults), failure,
  };
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

/** Upload each edit. Each is independent: one failed upload does not stop the rest. */
export async function convergeKothFiles(nitrado: RestartTarget, files: FileEdit[]): Promise<{ uploaded: number; errors: string[] }> {
  let uploaded = 0;
  const errors: string[] = [];
  for (const f of await differing(nitrado, files)) {
    try {
      await nitrado.uploadFile(f.dir, f.name, f.content);
      uploaded += 1;
    } catch (err) {
      errors.push(`${f.dir}/${f.name}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  return { uploaded, errors };
}

