import type { Database } from "@factions/db";
import { events, servers } from "@factions/db";
import { readCursor, writeCursor } from "@factions/event-log";
import { asc, gt } from "drizzle-orm";
import { applyEvent } from "./fold.js";

export const CONSUMER = "pole-projector";

/** Applies all unprocessed events in id order. Returns how many were applied. */
export async function runProjector(db: Database, opts: { batchSize?: number } = {}): Promise<number> {
  const batchSize = opts.batchSize ?? 500;
  let cursor = await readCursor(db, CONSUMER);
  let applied = 0;

  // The servers table is tiny and near-static, so its id -> map mapping is
  // loaded once here rather than re-queried per event (an N+1 query that
  // would issue ~14,000 redundant lookups during the historical backfill).
  const serverRows = await db.select().from(servers);
  const mapByServerId = new Map(serverRows.map((s) => [s.id, s.map]));

  for (;;) {
    const batch = await db.select().from(events)
      .where(gt(events.id, cursor)).orderBy(asc(events.id)).limit(batchSize);
    if (batch.length === 0) break;

    for (const ev of batch) {
      const map = mapByServerId.get(ev.serverId);
      if (map) await applyEvent(db, map, ev);
      cursor = ev.id;
      applied++;
    }
    await writeCursor(db, CONSUMER, cursor);
  }

  return applied;
}
