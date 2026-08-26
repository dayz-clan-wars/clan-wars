import type { Database } from "@factions/db";
import { consumerCursors } from "@factions/db";
import { eq } from "drizzle-orm";

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
