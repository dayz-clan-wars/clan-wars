import { admFiles, rawLines, servers, type Database } from "@factions/db";
import { asc, eq } from "drizzle-orm";
import { ingestFile } from "./ingest.js";

export type ReparseResult = { files: number; lines: number; eventsAppended: number; unparsedFlagLines: number };

/**
 * Re-run the parser over every line the worker has ever stored.
 *
 * `raw_lines` keeps every ADM line losslessly, so a parser that has since
 * learned a new line shape (kills, deaths, connects) can be pointed back at
 * the whole history. Each file is replayed from line 0 so the timeline
 * cursor crosses the same midnights it did the first time; every event
 * that already exists is skipped by `events_idempotency_uniq`, and only the
 * new shapes land — with ids at the head of the log and their true
 * `occurred_at`.
 *
 * ⚠️ Consumers see the backfilled events in id order, not time order. Only
 * the sessions projector pairs events by time, and it closes a stranded
 * session as 'restart' at the player's next connect. Nothing that reads
 * these types posts to Discord.
 */
export async function reparseStoredLines(db: Database, log: (line: string) => void = () => {}): Promise<ReparseResult> {
  const files = await db.select({
    id: admFiles.id, serverId: admFiles.serverId, filename: admFiles.filename, path: admFiles.path,
    bootAt: admFiles.bootAt, complete: admFiles.complete, clockOffsetMs: servers.clockOffsetMs,
  }).from(admFiles).innerJoin(servers, eq(servers.id, admFiles.serverId)).orderBy(asc(admFiles.id));

  const out: ReparseResult = { files: 0, lines: 0, eventsAppended: 0, unparsedFlagLines: 0 };
  for (const f of files) {
    const stored = await db.select({ lineIndex: rawLines.lineIndex, content: rawLines.content })
      .from(rawLines).where(eq(rawLines.admFileId, f.id)).orderBy(asc(rawLines.lineIndex));
    // The cursor needs every line in order. A gap would put every later
    // timestamp on the wrong side of a midnight; skip the file and say so.
    const contiguous = stored.every((r, i) => r.lineIndex === i);
    if (!contiguous) {
      log(`${f.filename}: stored lines are not contiguous, skipped`);
      continue;
    }
    const r = await ingestFile(db, {
      serverId: f.serverId, filename: f.filename, path: f.path, bootAt: f.bootAt,
      lines: stored.map((s) => s.content), clockOffsetMs: f.clockOffsetMs,
      markComplete: f.complete, reparse: true,
    });
    out.files++;
    out.lines += stored.length;
    out.eventsAppended += r.eventsAppended;
    out.unparsedFlagLines += r.unparsedFlagLines;
    if (r.eventsAppended > 0) log(`${f.filename}: ${r.eventsAppended} events`);
  }
  return out;
}
