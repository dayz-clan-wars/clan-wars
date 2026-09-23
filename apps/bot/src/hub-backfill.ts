import { parseLine } from "@factions/adm-parser";
import { events, rawLines, type Database } from "@factions/db";
import { and, asc, eq, gt, inArray, sql } from "drizzle-orm";

export type BackfillResult = { scanned: number; updated: number; unparsed: number };

/**
 * Give every past `player.hit`/`player.killed` event the positions the parser
 * now keeps (spec 2026-09-22-hub-combat §4.4), so `rebuild:kills` can mark Hub
 * kills retroactively.
 *
 * ⚠️ Re-parses with the SAME `parseLine` the worker uses, and takes the entry
 * at the event's own `sub_index` — the index the worker wrote it under — so a
 * backfilled payload is exactly what ingest would write today. Never a second,
 * hand-written regex: that is two statements of one fact.
 *
 * Idempotent: only events without `victimPos` are read, and the positions are
 * MERGED into the payload, never replacing a key already there.
 */
export async function backfillHubPositions(db: Database, opts: { serverId: number; apply: boolean; batchSize?: number }): Promise<BackfillResult> {
  const out: BackfillResult = { scanned: 0, updated: 0, unparsed: 0 };
  let after = 0;
  for (;;) {
    const batch = await db.select({ id: events.id, subIndex: events.subIndex, content: rawLines.content })
      // ⚠️ Joined on the natural key (file, line), NOT `events.raw_line_id`: a reparse
      // inserts events whose raw line already exists, so the worker's
      // onConflictDoNothing().returning() hands back nothing and `raw_line_id` is
      // null — 22 of 308 kill events in factions_live on 2026-09-22. Joining on the
      // id would skip every one of them silently, and their Hub kills would keep scoring.
      .from(events).leftJoin(rawLines, and(eq(rawLines.admFileId, events.admFileId), eq(rawLines.lineIndex, events.lineIndex)))
      .where(and(
        eq(events.serverId, opts.serverId), gt(events.id, after),
        inArray(events.type, ["player.hit", "player.killed"]),
        sql`not (${events.payload} ? 'victimPos')`,
      ))
      .orderBy(asc(events.id)).limit(opts.batchSize ?? 1000);
    if (batch.length === 0) break;
    for (const e of batch) {
      out.scanned++;
      const parsed = e.content === null ? undefined : parseLine(e.content)[e.subIndex];
      const add = parsed?.kind === "hit" ? { victimPos: parsed.event.victimPos, attackerPos: parsed.event.attackerPos }
        : parsed?.kind === "death" && parsed.event.kind === "killed" ? { victimPos: parsed.event.victimPos, killerPos: parsed.event.killerPos }
        : null;
      if (!add) { out.unparsed++; continue; }
      out.updated++;
      if (opts.apply) await db.update(events).set({ payload: sql`${events.payload} || ${JSON.stringify(add)}::jsonb` }).where(eq(events.id, e.id));
    }
    // ⚠️ Keyset on id, not OFFSET: a dry run changes nothing, so an offset loop
    // and a `not ? 'victimPos'` filter together would re-read the first page forever.
    after = batch[batch.length - 1]!.id;
  }
  return out;
}
