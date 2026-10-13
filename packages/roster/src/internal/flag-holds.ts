import type { Tx } from "@factions/declarations";
import type { Database } from "@factions/db";
import { factions, flagHolds } from "@factions/db";
import { CLAIMABLE_FLAGS, FLAG_CHANGE_WINDOW_MS, HOLDING_STATUSES } from "@factions/domain";
import { and, eq, gt, inArray, lte, or, type SQL } from "drizzle-orm";

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

/**
 * Reserve the new flag for this clan (spec §1 "Start"). The caller holds the
 * clan's `factions` row FOR UPDATE and `lockIdentity`, and has checked
 * `flagTakenTx` under that lock. Lock order: after `factions`. Returns the
 * deadline; the caller queues the `flag_change_started` notice LAST, after
 * any `renamed` feed row (§4.12: the queues come after every roster table,
 * and this hold IS a roster table).
 *
 * An expired RELEASED row for this texture may still exist if the sweep has
 * not run; it is deleted here first, or `flag_holds_texture_uniq` would
 * refuse a flag `freeFlagsDb` just offered as free.
 */
export async function startFlagChangeTx(tx: Tx, a: { serverId: number; factionId: number; texture: string; at: Date; stampsCooldown: boolean }): Promise<Date> {
  const until = new Date(a.at.getTime() + FLAG_CHANGE_WINDOW_MS);
  await tx.delete(flagHolds).where(and(
    eq(flagHolds.serverId, a.serverId), eq(flagHolds.texture, a.texture), eq(flagHolds.kind, "released"), lte(flagHolds.until, a.at),
  ));
  await tx.insert(flagHolds).values({
    serverId: a.serverId, texture: a.texture, factionId: a.factionId, kind: "pending", until, stampsCooldown: a.stampsCooldown, createdAt: a.at,
  });
  return until;
}

/**
 * Drop a clan's pending flag (spec §1: "frees the new flag immediately").
 *
 * ⚠️ Takes the clan's `factions` row FOR UPDATE before touching the hold:
 * raise-tick completes a change under that same row lock, so a cancel and a
 * completing raise serialise instead of both acting on one hold.
 */
export async function cancelFlagChangeDb(db: Database, factionId: number): Promise<"ok" | "nothing-pending"> {
  return db.transaction(async (tx) => {
    await tx.select({ id: factions.id }).from(factions).where(eq(factions.id, factionId)).for("update");
    const gone = await tx.delete(flagHolds)
      .where(and(eq(flagHolds.factionId, factionId), eq(flagHolds.kind, "pending")))
      .returning({ id: flagHolds.id });
    return gone.length > 0 ? "ok" : "nothing-pending";
  });
}
