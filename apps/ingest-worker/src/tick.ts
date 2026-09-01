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

/**
 * How many consecutive failures one file gets before it is written off.
 *
 * ⚠️ Without a bound, ONE un-ingestible file stops ingestion for the whole
 * server permanently: it is re-listed every tick, fails every tick, and while
 * it is pending the live file is never advanced to. Realistic triggers are a
 * crash-truncated header-less `.ADM` and a signed URL that serves an HTML
 * error page with HTTP 200 — both fail forever.
 */
const MAX_FILE_ATTEMPTS = 3;

export type TickDeps = {
  serverId: number;
  client: NitradoLike;
  backfillBudget: number;
  /**
   * Consecutive failure counts, keyed `${serverId}:${file.path}`.
   *
   * ⚠️ In memory for the process lifetime, deliberately NOT a column. Both
   * failure paths fire BEFORE `ingestFile` creates the `adm_files` row, and
   * that row requires a NOT NULL `boot_at` we do not have for a file we could
   * not read or parse. The cost of holding it in memory is three wasted
   * download attempts per process restart on a permanently-bad file.
   */
  failures: Map<string, number>;
};

export type TickResult = {
  filesProcessed: number;
  linesCaptured: number;
  eventsAppended: number;
  /** The offset in force for this tick, derived or retained. */
  offsetMs: number;
};

/** One ingestion pass for one server: backfill oldest-first under budget, then the live file. */
export async function ingestTick(db: Database, deps: TickDeps): Promise<TickResult> {
  const { serverId, client, backfillBudget, failures } = deps;
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
    // ⚠️ RETAIN the tightest bound ever observed; never overwrite with a
    // looser one. Every candidate is `trueOffset + writeLag`, so a tick that
    // happens to list only long-lag files derives a LARGER offset. Taking the
    // stored value's minimum keeps the estimate monotonically tightening;
    // overwriting would stamp one ADM file's early lines and its later lines
    // hours apart, and nothing can ever correct that
    // (`events_idempotency_uniq` excludes `occurred_at`).
    //
    // The stored value is never a placeholder: `clock_offset_ms` is NOT NULL
    // with no default and is populated from measured truth by
    // register-server.ts and replay-main.ts.
    const retained = Math.min(derived, server.clockOffsetMs);
    out.offsetMs = retained;
    if (retained !== server.clockOffsetMs) {
      // An offset moving in production is worth seeing.
      console.log(`ingest: server ${serverId} clock offset ${server.clockOffsetMs} -> ${retained}`);
      // The ONLY column of `servers` this worker writes. Identity is declared
      // by scripts/register-server.ts; the offset is observed.
      await db.update(servers).set({ clockOffsetMs: retained }).where(eq(servers.id, serverId));
    }
  }

  // ⚠️ HAZARD, knowingly unfixed: "newest" is decided purely by the filename
  // timestamp, which is server-LOCAL. If a server's local clock ever steps
  // BACKWARDS (a DST transition, an operator changing the timezone), the file
  // created after the step sorts BEFORE its predecessor. The genuinely live
  // file is then treated as an old file, marked `complete`, and skipped
  // forever, while the stale one is re-downloaded every tick — the symptom is
  // a server that silently stops ingesting after a backwards clock step. We
  // accept this: the three production servers run fixed UTC+4/+7 with no DST,
  // and cross-checking against Nitrado's mtime would introduce a worse hazard
  // that fires on routine re-uploads.
  const newestPath = files[files.length - 1]!.path;
  let budget = backfillBudget;
  let allCaughtUp = true;

  /**
   * Count one failure. Returns true while the file should still block the
   * live file, false once it has been written off.
   */
  const recordFailure = (key: string, path: string): boolean => {
    const attempts = (failures.get(key) ?? 0) + 1;
    failures.set(key, attempts);
    if (attempts >= MAX_FILE_ATTEMPTS) {
      console.error(
        `ingest: quarantining ${path} after ${attempts} consecutive failures; ` +
        "it will be skipped for the rest of this process so the live file can proceed",
      );
      return false;
    }
    return true;
  };

  for (const file of files) {
    const isNewest = file.path === newestPath;
    const failureKey = `${serverId}:${file.path}`;

    const [row] = await db.select().from(admFiles)
      .where(and(eq(admFiles.serverId, serverId), eq(admFiles.filename, file.name)));

    if (row?.complete && !isNewest) continue;

    // A quarantined file is still re-listed every tick. Skip it here, before
    // spending a download, rather than re-attempting it forever.
    if ((failures.get(failureKey) ?? 0) >= MAX_FILE_ATTEMPTS) continue;

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
      if (recordFailure(failureKey, file.path)) allCaughtUp = false;
      continue;
    }

    let parsed: { bootAt: Date; lines: string[] };
    try {
      // ⚠️ Only the live file may have its final line dropped: it is the one
      // the server is still appending to, so its last line can arrive
      // truncated mid-write. Storing that partial line would advance the
      // cursor past it and the complete version could never be written.
      parsed = parseAdmContent(text, { dropPartialTrailingLine: isNewest });
    } catch (err) {
      // A file with no boot header cannot be timestamped at all. Skip it
      // rather than throwing: one bad file must not stop the sweep.
      console.error(`ingest: unusable file ${file.path}`, err);
      if (recordFailure(failureKey, file.path)) allCaughtUp = false;
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

    // The file read cleanly: forget any earlier failures for it.
    failures.delete(failureKey);

    out.filesProcessed++;
    out.linesCaptured += r.linesCaptured;
    out.eventsAppended += r.eventsAppended;
    if (r.unparsedFlagLines > 0) {
      console.warn(`ingest: ${r.unparsedFlagLines} unparsed flag-shaped lines in ${file.name}`);
    }
  }

  return out;
}
