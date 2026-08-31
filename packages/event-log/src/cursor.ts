import type { Database } from "@factions/db";
import { consumerCursors, events } from "@factions/db";
import { asc, eq, gt } from "drizzle-orm";

export async function readCursor(db: Database, consumer: string): Promise<number> {
  const [row] = await db.select().from(consumerCursors)
    .where(eq(consumerCursors.consumerName, consumer));
  return row?.lastEventId ?? 0;
}

export async function writeCursor(db: Database, consumer: string, lastEventId: number): Promise<void> {
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
