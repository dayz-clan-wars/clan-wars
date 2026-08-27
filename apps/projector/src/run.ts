import type { Database } from "@factions/db";
import { events, servers } from "@factions/db";
import { readCursor, writeCursor } from "@factions/event-log";
import { asc, gt } from "drizzle-orm";
import { applyEvent } from "./fold.js";

export const CONSUMER = "pole-projector";

/**
 * What one projector pass did.
 *
 * `applied` counts only events actually handed to applyEvent — an event whose
 * server has no row in `servers` is skipped, and counting it as applied
 * overstated the work done. `unknownServer` and `unboundFolds` make both
 * silent-drop paths visible instead: an unbound fold is a lost pole-loss
 * signal, and pole loss is one of only two consequential signals the ADM log
 * provides.
 */
export type ProjectorResult = {
  applied: number;
  unknownServer: number;
  unboundFolds: number;
};

/** Applies all unprocessed events in id order. */
export async function runProjector(
  db: Database,
  opts: { batchSize?: number } = {},
): Promise<ProjectorResult> {
  const batchSize = opts.batchSize ?? 500;
  let cursor = await readCursor(db, CONSUMER);
  let applied = 0;
  let unknownServer = 0;
  let unboundFolds = 0;

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
      if (map) {
        const outcome = await applyEvent(db, map, ev);
        if (outcome.unboundFold) unboundFolds++;
        applied++;
      } else {
        unknownServer++;
      }
      cursor = ev.id;
    }
    await writeCursor(db, CONSUMER, cursor);
  }

  return { applied, unknownServer, unboundFolds };
}
