import type { Database } from "@factions/db";
import { events } from "@factions/db";
import type { EventType } from "@factions/domain";

export type AppendEventInput = {
  serverId: number;
  admFileId: number;
  lineIndex: number;
  subIndex: number;
  type: EventType;
  occurredAt: Date;
  payload: unknown;
  rawLineId?: number;
};

/**
 * Append one event, ignoring duplicates on the (server, file, line, sub) idempotency key.
 *
 * Returns `true` when a row was actually inserted, `false` when the idempotency
 * conflict suppressed it. This lets an ingest worker report how many events were
 * genuinely appended without a separate count query before/after each insert.
 */
export async function appendEvent(db: Database, input: AppendEventInput): Promise<boolean> {
  const rows = await db.insert(events).values({
    serverId: input.serverId,
    admFileId: input.admFileId,
    lineIndex: input.lineIndex,
    subIndex: input.subIndex,
    type: input.type,
    occurredAt: input.occurredAt,
    payload: input.payload as object,
    rawLineId: input.rawLineId,
  }).onConflictDoNothing({
    target: [events.serverId, events.admFileId, events.lineIndex, events.subIndex],
  }).returning();

  return rows.length > 0;
}
