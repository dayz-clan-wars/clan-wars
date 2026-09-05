import type { Database } from "@factions/db";
import { declarations, poles } from "@factions/db";
import { tooClose, RELEASED_POLE_GRACE_MS } from "@factions/domain";
import { and, eq, isNull, lt, sql } from "drizzle-orm";

export type Tx = Parameters<Parameters<Database["transaction"]>[0]>[0];

export type Owner = { factionId: number } | { dayzId: string; serverId: number };
export type DeclareArgs = {
  serverId: number; poleKey: string; x: number; y: number; z: number;
  owner: { factionId: number } | { dayzId: string };
  evidence: { ceremonyId: number } | { eventId: number };
  at: Date;
};
export type DeclareOutcome =
  | { ok: true; id: number }
  | { ok: false; reason: "too-close" | "pole-taken" | "owner-has-base" };

export type Declaration = { id: number; poleKey: string; x: string; y: string; z: string; declaredAt: Date };

/**
 * The ONLY way a declarations row is written (spec §4.1, §14).
 *
 * ⚠️ Two layers guard the 200 m rule, for two different races:
 *
 * 1. `pg_advisory_xact_lock` (two-int form, namespaced by `hashtext`) is the
 *    FIRST statement, so every declarer on this server serialises through it
 *    before it reads a single row. This is the launch-day / empty-table
 *    case: `SELECT … FOR UPDATE` locks nothing when there is nothing to
 *    lock, so two claims 150 m apart against an empty table would both read
 *    zero neighbours and both commit without it.
 * 2. `.for("update")` on the existing rows still matters once the table is
 *    non-empty: it is what stops a concurrent `releaseTx` from deleting (or
 *    another `declareTx` from inserting) a row this check just read, between
 *    the read and this transaction's commit.
 *
 * ⚠️ Lock order (spec §4.12): the caller holds `factions` (if it holds
 * anything) before calling this. `declarations` comes second in the order
 * for that reason — this function must never be called while holding a lock
 * that comes after `declarations`.
 */
export async function declareTx(tx: Tx, a: DeclareArgs): Promise<DeclareOutcome> {
  await tx.execute(sql`select pg_advisory_xact_lock(hashtext('declarations'), ${a.serverId})`);

  const existing = await tx.select({ poleKey: declarations.poleKey, x: declarations.x, z: declarations.z })
    .from(declarations)
    .where(eq(declarations.serverId, a.serverId))
    .for("update");

  // Exclude a row already sitting on THIS pole (distance 0) from the spacing
  // check — that case is "pole-taken", decided below by the unique index,
  // not "too-close" to itself.
  const neighbours = existing.filter((r) => r.poleKey !== a.poleKey);
  if (tooClose({ x: a.x, z: a.z }, neighbours.map((r) => ({ x: Number(r.x), z: Number(r.z) })))) {
    return { ok: false, reason: "too-close" };
  }

  try {
    // ⚠️ Nested in a SAVEPOINT (drizzle's `tx.transaction` inside a tx), not
    // a bare insert. `tx` here is the CALLER's transaction — Postgres marks
    // the whole transaction aborted the instant the insert's unique-index
    // violation reaches the server, so catching just the JS rejection isn't
    // enough: the caller's eventual COMMIT would then fail on an aborted
    // transaction, re-throwing the very error this catch already handled.
    // The savepoint rolls back only the insert, leaving the caller's
    // transaction usable for whatever it does next.
    const [row] = await tx.transaction((tx2) => tx2.insert(declarations).values({
      serverId: a.serverId, poleKey: a.poleKey,
      x: a.x.toFixed(2), y: a.y.toFixed(2), z: a.z.toFixed(2),
      ownerFactionId: "factionId" in a.owner ? a.owner.factionId : null,
      ownerDayzId: "dayzId" in a.owner ? a.owner.dayzId : null,
      evidenceEventId: "eventId" in a.evidence ? a.evidence.eventId : null,
      evidenceCeremonyId: "ceremonyId" in a.evidence ? a.evidence.ceremonyId : null,
      declaredAt: a.at,
    }).returning({ id: declarations.id }));
    return { ok: true, id: row!.id };
  } catch (err) {
    // Same pattern as faction-store.reserve: the index decides, the message names it.
    const msg = String(err);
    if (msg.includes("declarations_pole_uniq")) return { ok: false, reason: "pole-taken" };
    if (msg.includes("declarations_faction_uniq") || msg.includes("declarations_player_uniq")) {
      return { ok: false, reason: "owner-has-base" };
    }
    throw err;
  }
}

const ownerWhere = (o: Owner) =>
  "factionId" in o
    ? eq(declarations.ownerFactionId, o.factionId)
    : and(eq(declarations.serverId, o.serverId), eq(declarations.ownerDayzId, o.dayzId))!;

/**
 * Release a declaration and start the pole's 3-day grace (spec §5.2).
 *
 * ⚠️ The grace write is in the same transaction as the delete. A release
 * whose grace never lands publishes the old base the instant it is released
 * — the exact outcome the grace exists to prevent — with no error anywhere.
 *
 * Lock order (spec §4.12): as with `declareTx`, the caller holds `factions`
 * first if it holds anything; this takes `declarations` then `poles`.
 */
export async function releaseTx(tx: Tx, owner: Owner, at: Date): Promise<boolean> {
  const [gone] = await tx.delete(declarations).where(ownerWhere(owner))
    .returning({ serverId: declarations.serverId, poleKey: declarations.poleKey });
  if (!gone) return false;
  await tx.update(poles)
    .set({ graceUntil: new Date(at.getTime() + RELEASED_POLE_GRACE_MS) })
    .where(and(eq(poles.serverId, gone.serverId), eq(poles.poleKey, gone.poleKey)));
  return true;
}

const shape = { id: declarations.id, poleKey: declarations.poleKey, x: declarations.x, y: declarations.y, z: declarations.z, declaredAt: declarations.declaredAt };

export async function declarationForFaction(db: Database | Tx, factionId: number): Promise<Declaration | null> {
  const [row] = await db.select(shape).from(declarations).where(eq(declarations.ownerFactionId, factionId));
  return row ?? null;
}

export async function declarationForPlayer(db: Database | Tx, serverId: number, dayzId: string): Promise<Declaration | null> {
  const [row] = await db.select(shape).from(declarations)
    .where(and(eq(declarations.serverId, serverId), eq(declarations.ownerDayzId, dayzId)));
  return row ?? null;
}

/**
 * Rule 2: every raised, undeclared pole past its grace, with the flag flying
 * there (spec §4.2). Texture-agnostic on purpose — see the test.
 */
export async function publicPoles(db: Database, serverId: number, now: Date) {
  return db.select({ poleKey: poles.poleKey, x: poles.x, y: poles.y, z: poles.z, texture: poles.currentTexture })
    .from(poles)
    .leftJoin(declarations, and(eq(declarations.serverId, poles.serverId), eq(declarations.poleKey, poles.poleKey)))
    .where(and(
      eq(poles.serverId, serverId),
      eq(poles.flagRaised, true),
      isNull(declarations.id),
      lt(poles.graceUntil, now),
    ))
    .orderBy(poles.poleKey);
}
