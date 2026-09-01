import type { Database } from "@factions/db";
import { admFiles, servers } from "@factions/db";
import type { AdmFileRef } from "@factions/nitrado";
import { and, eq } from "drizzle-orm";
import { parseAdmContent } from "./parse-adm-content.js";
import { ingestFile } from "./ingest.js";
import { deriveClockOffsetMs } from "./derive-clock-offset.js";

/** Structural, so the tick is testable without HTTP. */
export type NitradoLike = {
  listAdmFiles(): Promise<AdmFileRef[]>;
  downloadFile(path: string): Promise<string>;
};

export type TickDeps = { serverId: number; client: NitradoLike; backfillBudget: number };

export type TickResult = {
  filesProcessed: number;
  linesCaptured: number;
  eventsAppended: number;
  /** The offset in force for this tick, derived or retained. */
  offsetMs: number;
};

/** One ingestion pass for one server: backfill oldest-first under budget, then the live file. */
export async function ingestTick(db: Database, deps: TickDeps): Promise<TickResult> {
  const { serverId, client, backfillBudget } = deps;
  const [server] = await db.select().from(servers).where(eq(servers.id, serverId));
  if (!server) throw new Error(`ingestTick: no server ${serverId}`);

  const out: TickResult = { filesProcessed: 0, linesCaptured: 0, eventsAppended: 0, offsetMs: server.clockOffsetMs };

  const files = await client.listAdmFiles();
  if (files.length === 0) return out;

  // ⚠️ Exclude files with a non-positive mtime. Nitrado sometimes omits
  // modified_at and the client reports that faithfully as 0; since the
  // derivation takes the MINIMUM candidate, a 0 would win and shift every
  // timestamp by decades. `localTimestampMs` is never null (the client drops
  // files whose filename does not parse), so only the finite check applies —
  // a test still feeds NaN directly, hence the guard.
  const candidates = files
    .filter((f) => Number.isFinite(f.localTimestampMs) && f.modifiedAtMs > 0)
    .map((f) => ({ localTimestampMs: f.localTimestampMs, modifiedAtMs: f.modifiedAtMs }));

  const derived = deriveClockOffsetMs(candidates);
  if (derived !== null) {
    out.offsetMs = derived;
    // The ONLY column of `servers` this worker writes. Identity is declared
    // by scripts/register-server.ts; the offset is observed.
    await db.update(servers).set({ clockOffsetMs: derived }).where(eq(servers.id, serverId));
  }

  const newestPath = files[files.length - 1]!.path;
  let budget = backfillBudget;
  let allCaughtUp = true;

  for (const file of files) {
    const isNewest = file.path === newestPath;

    const [row] = await db.select().from(admFiles)
      .where(and(eq(admFiles.serverId, serverId), eq(admFiles.filename, file.name)));

    if (row?.complete && !isNewest) continue;

    if (!isNewest) {
      if (budget <= 0) { allCaughtUp = false; continue; }
      budget--;
    } else if (!allCaughtUp) {
      // ⚠️ Do not advance to the live file while older files are still
      // pending: its timestamps depend on the history before it.
      continue;
    }

    let text: string;
    try {
      text = await client.downloadFile(file.path);
    } catch (err) {
      console.error(`ingest: download failed for ${file.path}`, err);
      allCaughtUp = false;
      continue;
    }

    let parsed: { bootAt: Date; lines: string[] };
    try {
      parsed = parseAdmContent(text);
    } catch (err) {
      // A file with no boot header cannot be timestamped at all. Skip it
      // rather than throwing: one bad file must not stop the sweep.
      console.error(`ingest: unusable file ${file.path}`, err);
      allCaughtUp = false;
      continue;
    }

    const r = await ingestFile(db, {
      serverId,
      filename: file.name,
      path: file.path,
      bootAt: parsed.bootAt,
      lines: parsed.lines,
      clockOffsetMs: out.offsetMs,
      markComplete: !isNewest,
    });

    out.filesProcessed++;
    out.linesCaptured += r.linesCaptured;
    out.eventsAppended += r.eventsAppended;
    if (r.unparsedFlagLines > 0) {
      console.warn(`ingest: ${r.unparsedFlagLines} unparsed flag-shaped lines in ${file.name}`);
    }
  }

  return out;
}
