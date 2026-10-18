import type { Database } from "@factions/db";
import { events } from "@factions/db";
import { readCursor } from "@factions/event-log";
import { sweepFlagHoldsDb } from "@factions/roster/internal";
import { eq } from "drizzle-orm";
import { RAISE_CONSUMER } from "./raise-tick.js";

/**
 * Lapse pending flag changes (spec 2026-10-13 §2), and clear any `released`
 * hold left from before old flags returned to the pool at once.
 *
 * ⚠️ `foldedThrough` is the time of the last event the RAISE consumer
 * committed, not now: a pending change lapses only once every raise that
 * could have completed it has been folded. Runs right after raiseTick so
 * that, on a healthy tick, it is as current as it can be. The cursor is
 * global across servers; with one managed server that is exact, and the
 * backstop in the sweep bounds any other case.
 */
export async function flagHoldTick(db: Database, now: Date): Promise<{ lapsed: number; released: number }> {
  const cursor = await readCursor(db, RAISE_CONSUMER);
  const [last] = cursor === 0 ? [] : await db.select({ at: events.occurredAt }).from(events).where(eq(events.id, cursor));
  return sweepFlagHoldsDb(db, { now, foldedThrough: last?.at ?? null });
}
