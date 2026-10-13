import type { Tx } from "@factions/declarations";
import type { Database } from "@factions/db";
import { factions, flagHolds } from "@factions/db";
import { CLAIMABLE_FLAGS, HOLDING_STATUSES } from "@factions/domain";
import { and, eq, gt, inArray, or, type SQL } from "drizzle-orm";

/**
 * Is a `flag_holds` row still holding its flag?
 *
 * ⚠️ `pending` is live until the SWEEP deletes it, not until `until`. The
 * sweep waits for the raise consumer to fold events past the deadline, so a
 * raise logged before the deadline can still complete the change; if the flag
 * were free the instant `until` passed, a founder could take it in that gap
 * and the completing raise would promote a texture another clan now holds.
 * `released` has no such dependency and expires on the clock.
 */
export function liveHold(now: Date): SQL {
  return or(eq(flagHolds.kind, "pending"), gt(flagHolds.until, now))!;
}

/**
 * One flag, one clan, across `factions` AND `flag_holds`. Binding only under
 * `lockIdentity(tx, serverId)`, which every caller that then takes the flag
 * holds — `factions_holding_texture_uniq` and `flag_holds_texture_uniq`
 * each see only their own table.
 */
export async function flagTakenTx(tx: Tx | Database, serverId: number, texture: string, now: Date): Promise<boolean> {
  const [clan] = await tx.select({ id: factions.id }).from(factions)
    .where(and(eq(factions.serverId, serverId), eq(factions.texture, texture), inArray(factions.status, [...HOLDING_STATUSES])));
  if (clan) return true;
  const [hold] = await tx.select({ id: flagHolds.id }).from(flagHolds)
    .where(and(eq(flagHolds.serverId, serverId), eq(flagHolds.texture, texture), liveHold(now)));
  return hold !== undefined;
}

/** The claim form's and the rebrand picker's one list (spec §2 "Free pool"), in pool order. */
export async function freeFlagsDb(db: Tx | Database, serverId: number, now: Date): Promise<string[]> {
  const held = await db.select({ texture: factions.texture }).from(factions)
    .where(and(eq(factions.serverId, serverId), inArray(factions.status, [...HOLDING_STATUSES])));
  const holds = await db.select({ texture: flagHolds.texture }).from(flagHolds)
    .where(and(eq(flagHolds.serverId, serverId), liveHold(now)));
  const taken = new Set([...held, ...holds].map((r) => r.texture));
  return CLAIMABLE_FLAGS.filter((f) => !taken.has(f));
}
