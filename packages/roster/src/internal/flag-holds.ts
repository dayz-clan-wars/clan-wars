import type { Tx } from "@factions/declarations";
import type { Database } from "@factions/db";
import { factions, factionTextures, flagHolds } from "@factions/db";
import { CLAIMABLE_FLAGS, FLAG_CHANGE_WINDOW_MS, HOLDING_STATUSES, OLD_FLAG_HOLD_MS } from "@factions/domain";
import { and, eq, exists, gt, inArray, isNull, lte, ne, or, sql, type SQL } from "drizzle-orm";
import { appendFactionEventTx } from "./feed-store";
import { noticeClanTx, noticeUserTx } from "./notices";

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
 *
 * ⚠️ ONE statement, so both tables are read from one snapshot. Raise-tick's
 * completion moves a texture from a pending `flag_holds` row into
 * `factions.texture` without the identity lock; under READ COMMITTED two
 * selects each take a fresh snapshot, and a completion committing between
 * them makes the flag look free in both — a rebrand or founding then takes a
 * flag another clan flies (two clans on one flag, and that clan's own later
 * completion hits `factions_holding_texture_uniq` on every tick).
 */
export async function flagTakenTx(tx: Tx | Database, serverId: number, texture: string, now: Date): Promise<boolean> {
  const clan = tx.select({ id: factions.id }).from(factions)
    .where(and(eq(factions.serverId, serverId), eq(factions.texture, texture), inArray(factions.status, [...HOLDING_STATUSES])));
  const hold = tx.select({ id: flagHolds.id }).from(flagHolds)
    .where(and(eq(flagHolds.serverId, serverId), eq(flagHolds.texture, texture), liveHold(now)));
  const [row] = await tx.execute<{ taken: boolean }>(sql`select ${or(exists(clan), exists(hold))} as taken`);
  return row!.taken === true;
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

/**
 * Spec §3: a full member raised the clan's pending flag at its home pole.
 * Promote it. The caller holds the clan's `factions` row FOR UPDATE.
 *
 * Writes `factions` → `flag_holds` → `faction_textures`, the §4.12 order.
 * Takes no new flag (the pending hold already reserved it), so no identity
 * lock. Announcing is separate (`announceFlagChangeTx`) because the feed and
 * notice queues must be written LAST in the caller's transaction, after any
 * defense or revive the same raise also performs.
 *
 * ⚠️ `until` is compared with the EVENT's time, never the wall clock — the
 * same rule as FLAG_DOWN_MS in raise-tick: during a backlog a raise logged
 * in time is folded late and must still count.
 */
export async function completeFlagChangeTx(tx: Tx, a: { factionId: number; serverId: number; texture: string; at: Date }): Promise<{ previousTexture: string; name: string; tag: string } | null> {
  const [hold] = await tx.select({ id: flagHolds.id, stampsCooldown: flagHolds.stampsCooldown }).from(flagHolds)
    .where(and(eq(flagHolds.factionId, a.factionId), eq(flagHolds.kind, "pending"), eq(flagHolds.texture, a.texture), gt(flagHolds.until, a.at)));
  if (!hold) return null;
  // ⚠️ Defence in depth: `flagTakenTx` should make this impossible, but if
  // another holding clan already flies this texture, promoting it violates
  // `factions_holding_texture_uniq` — and a throw here rolls back the cursor
  // too, so the raise consumer would retry this one event every tick and
  // wedge the whole server. Checked, never caught: a caught error inside a
  // postgres transaction aborts it anyway. The hold is left for the sweep.
  const [rival] = await tx.select({ id: factions.id }).from(factions).where(and(
    eq(factions.serverId, a.serverId), eq(factions.texture, a.texture), inArray(factions.status, [...HOLDING_STATUSES]), ne(factions.id, a.factionId),
  ));
  if (rival) {
    console.error(`flag change: faction ${a.factionId} cannot take ${a.texture}, already flown by faction ${rival.id}; not completing`);
    return null;
  }
  const [before] = await tx.select({ texture: factions.texture, name: factions.name, tag: factions.tag }).from(factions).where(eq(factions.id, a.factionId));
  await tx.update(factions)
    .set({ texture: a.texture, ...(hold.stampsCooldown ? { renamedAt: a.at } : {}) })
    .where(eq(factions.id, a.factionId));
  await tx.delete(flagHolds).where(eq(flagHolds.id, hold.id));
  await tx.insert(flagHolds).values({
    serverId: a.serverId, texture: before!.texture, factionId: a.factionId, kind: "released",
    until: new Date(a.at.getTime() + OLD_FLAG_HOLD_MS), createdAt: a.at,
  });
  await tx.update(factionTextures).set({ toAt: a.at })
    .where(and(eq(factionTextures.factionId, a.factionId), isNull(factionTextures.toAt)));
  await tx.insert(factionTextures).values({ factionId: a.factionId, texture: a.texture, fromAt: a.at });
  return { previousTexture: before!.texture, name: before!.name, tag: before!.tag };
}

/** The feed row and the clan-channel notice for a completed flag change. Last in the transaction (§4.12). */
export async function announceFlagChangeTx(tx: Tx, a: { serverId: number; factionId: number; name: string; tag: string; texture: string; previousTexture: string; gamertag: string; at: Date }): Promise<void> {
  await appendFactionEventTx(tx, {
    serverId: a.serverId, factionId: a.factionId, kind: "flag_changed", occurredAt: a.at,
    payload: { name: a.name, tag: a.tag, texture: a.texture, previousTexture: a.previousTexture, actor: a.gamertag },
  });
  await noticeClanTx(tx, {
    serverId: a.serverId, factionId: a.factionId, kind: "flag_changed", occurredAt: a.at,
    payload: { texture: a.texture, previousTexture: a.previousTexture, gamertag: a.gamertag },
  });
}

/**
 * Spec §2 "Sweep". Released holds go on the clock. A pending hold lapses only
 * once the raise consumer has folded an event at or past its deadline
 * (`foldedThrough`), so a raise logged in time but not yet folded can still
 * complete it — or, as a backstop for a log that has stopped, a full
 * FLAG_CHANGE_WINDOW_MS after the deadline.
 *
 * ⚠️ Each lapse locks the clan's `factions` row first (§4.12) — the same lock
 * a completing raise holds — and re-reads the hold under it.
 */
export async function sweepFlagHoldsDb(db: Database, a: { now: Date; foldedThrough: Date | null }): Promise<{ lapsed: number; released: number }> {
  const released = await db.delete(flagHolds)
    .where(and(eq(flagHolds.kind, "released"), lte(flagHolds.until, a.now)))
    .returning({ id: flagHolds.id });

  const backstop = new Date(a.now.getTime() - FLAG_CHANGE_WINDOW_MS);
  const due = await db.select({ id: flagHolds.id, factionId: flagHolds.factionId }).from(flagHolds).where(and(
    eq(flagHolds.kind, "pending"),
    a.foldedThrough === null
      ? lte(flagHolds.until, backstop)
      : or(lte(flagHolds.until, a.foldedThrough), lte(flagHolds.until, backstop))!,
  ));

  let lapsed = 0;
  for (const d of due) {
    lapsed += await db.transaction(async (tx) => {
      const [clan] = await tx.select({ serverId: factions.serverId, leader: factions.leaderDiscordId }).from(factions)
        .where(eq(factions.id, d.factionId)).for("update");
      const gone = await tx.delete(flagHolds).where(and(eq(flagHolds.id, d.id), eq(flagHolds.kind, "pending")))
        .returning({ texture: flagHolds.texture });
      if (!clan || gone.length === 0) return 0; // completed or cancelled meanwhile
      const payload = { texture: gone[0]!.texture };
      await noticeClanTx(tx, { serverId: clan.serverId, factionId: d.factionId, kind: "flag_change_lapsed", occurredAt: a.now, payload });
      await noticeUserTx(tx, { serverId: clan.serverId, factionId: d.factionId, discordId: clan.leader, kind: "flag_change_lapsed", occurredAt: a.now, payload });
      return 1;
    });
  }
  return { lapsed, released: released.length };
}
