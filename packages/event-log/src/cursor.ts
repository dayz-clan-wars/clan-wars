import type { Database } from "@factions/db";
import { consumerCursors, events } from "@factions/db";
import { asc, eq, gt } from "drizzle-orm";

export async function readCursor(db: Database, consumer: string): Promise<number> {
  const [row] = await db.select().from(consumerCursors)
    .where(eq(consumerCursors.consumerName, consumer));
  return row?.lastEventId ?? 0;
}

/** The transaction handle drizzle hands to `db.transaction`. */
type Tx = Parameters<Parameters<Database["transaction"]>[0]>[0];

/**
 * Takes a `Tx` as well as a `Database` on purpose. A consumer that commits its
 * cursor in the same transaction as the event's effects cannot replay an
 * already-applied event: either both land or neither does. Callers that write
 * the cursor once per batch (the pre-existing pattern) pass the `Database`.
 */
export async function writeCursor(db: Database | Tx, consumer: string, lastEventId: number): Promise<void> {
  await db.insert(consumerCursors)
    .values({ consumerName: consumer, lastEventId, updatedAt: new Date() })
    .onConflictDoUpdate({
      target: consumerCursors.consumerName,
      set: { lastEventId, updatedAt: new Date() },
    });
}

export type EventRow = typeof events.$inferSelect;

/** Events strictly after `afterId`, in id order. Id order IS causal order here. */
export async function readEventBatch(db: Database, afterId: number, limit: number): Promise<EventRow[]> {
  return db.select().from(events).where(gt(events.id, afterId)).orderBy(asc(events.id)).limit(limit);
}
