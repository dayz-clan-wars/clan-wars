import type { Database } from "@factions/db";
import { declarations, events, factionMembers, poles } from "@factions/db";
import { tooClose, RELEASED_POLE_GRACE_MS, SOLO_LAPSE_MS } from "@factions/domain";
import { and, desc, eq, isNotNull, isNull, lt, sql } from "drizzle-orm";

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
 * Take the server's declaration lock — the transaction-scoped advisory lock
 * every declaration writer serialises on.
 *
 * ⚠️ Call this BEFORE `releaseTx` (or before reading a row you are about to
 * release) in any transaction that later calls `declareTx`. `releaseTx`
 * DELETEs a `declarations` row, which takes a row lock; `declareTx` takes the
 * advisory lock first and then scans `declarations … FOR UPDATE`. Doing the
 * delete first inverts those two: T1 deletes its row and then waits for the
 * advisory lock, while T2 holds the advisory lock and its FOR UPDATE scan
 * blocks on T1's uncommitted delete. Postgres breaks that cycle by aborting
 * one of them with a raw driver error — not a `RebindAbort`/`ReserveAbort`,
 * so the caller's outcome mapping never sees it and the player gets a crash
 * instead of a refusal. Two concurrent rebinds on one server are enough.
 *
 * Advisory *xact* locks are re-entrant within a transaction, so `declareTx`
 * keeps taking it unconditionally and a caller that already took it here pays
 * nothing. Lock order (spec §4.12) is unchanged: callers still write
 * `factions` first, so the chain is still `factions` → `declarations`.
 */
export async function lockDeclarations(tx: Tx, serverId: number): Promise<void> {
  await tx.execute(sql`select pg_advisory_xact_lock(hashtext('declarations'), ${serverId})`);
}

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
 *
 * The own-pole exclusion below assumes `a.poleKey` and `a.x`/`a.y`/`a.z`
 * describe the same point — the key IS the coordinate string (see
 * `@factions/domain` pole-key.ts) — so callers must pass matching values.
 */
export async function declareTx(tx: Tx, a: DeclareArgs): Promise<DeclareOutcome> {
  await lockDeclarations(tx, a.serverId);

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

export type RaisedPole = { poleKey: string; x: number; y: number; z: number; eventId: number; occurredAt: Date };

/**
 * Poles the log has seen this player raise a flag at — the only ones a solo
 * may declare (spec §5.2). Newest raise first, one row per pole: the newest
 * raise is the evidence `declareSolo` cites, and offering the same pole twice
 * would let the site show a player two identical choices.
 *
 * Takes `Database | Tx` because `declareSolo` re-reads it INSIDE its own
 * transaction, so the raise it cites is the raise it checked.
 */
export async function raisedPolesFor(db: Database | Tx, serverId: number, dayzId: string): Promise<RaisedPole[]> {
  const rows = await db.select({
    poleKey: sql<string>`${events.payload}->>'poleKey'`,
    x: sql<string>`${events.payload}->'pole'->>'x'`,
    y: sql<string>`${events.payload}->'pole'->>'y'`,
    z: sql<string>`${events.payload}->'pole'->>'z'`,
    eventId: events.id, occurredAt: events.occurredAt,
  }).from(events).where(and(
    eq(events.serverId, serverId), eq(events.type, "flag.raised"),
    sql`${events.payload}->>'dayzId' = ${dayzId}`,
  )).orderBy(desc(events.occurredAt), desc(events.id));
  const seen = new Set<string>();
  return rows.filter((r) => (seen.has(r.poleKey) ? false : (seen.add(r.poleKey), true)))
    .map((r) => ({ poleKey: r.poleKey, x: Number(r.x), y: Number(r.y), z: Number(r.z), eventId: r.eventId, occurredAt: r.occurredAt }));
}

/** A solo's declaration: the same pole binding a clan gets, evidenced by a raise. */
export async function declareSolo(db: Database, a: { serverId: number; dayzId: string; poleKey: string; at: Date }):
  Promise<DeclareOutcome | { ok: false; reason: "no-raise" | "in-clan" }> {
  return db.transaction(async (tx) => {
    // Rule 3: in a clan, your declaration is the clan's. Checked inside the
    // transaction so an accept landing at the same instant cannot slip past.
    const [member] = await tx.select({ id: factionMembers.id }).from(factionMembers)
      .where(and(eq(factionMembers.serverId, a.serverId), eq(factionMembers.dayzId, a.dayzId)));
    if (member) return { ok: false as const, reason: "in-clan" as const };
    const raise = (await raisedPolesFor(tx, a.serverId, a.dayzId)).find((r) => r.poleKey === a.poleKey);
    if (!raise) return { ok: false as const, reason: "no-raise" as const };
    return declareTx(tx, {
      serverId: a.serverId, poleKey: a.poleKey, x: raise.x, y: raise.y, z: raise.z,
      owner: { dayzId: a.dayzId }, evidence: { eventId: raise.eventId }, at: a.at,
    });
  });
}

/**
 * Rule 4 for solos: a declaration whose declarant has not raised their flag at
 * their own pole for SOLO_LAPSE_MS is released on the spot (guide ch. 4).
 * Returns who lapsed so the caller can tell them — increment 3 queues the DM.
 *
 * ⚠️ The clock starts at DECLARING, not at the raise that evidenced it. A solo
 * may declare today citing a raise the log recorded a month ago; releasing
 * them on the next tick would give them a base that never existed. So a row
 * lapses only when BOTH `declared_at` is older than the cutoff AND no raise by
 * that declarant at that pole is newer than it — the clock runs from the later
 * of the two.
 *
 * ⚠️ The NOT EXISTS reads `events` by (server_id, poleKey, dayzId,
 * occurred_at); `events_raise_lookup_idx` covers (server_id, poleKey,
 * texture, occurred_at), so this is a partial-index walk plus a filter on
 * `dayzId` rather than an index lookup. Acceptable for the handful of solo
 * declarations a tick examines; it would not be for thousands.
 */
export async function lapseSolos(db: Database, serverId: number, now: Date): Promise<{ dayzId: string; poleKey: string }[]> {
  const cutoff = new Date(now.getTime() - SOLO_LAPSE_MS);
  // ⚠️ The date is interpolated as an ISO string cast to timestamptz: binding
  // a raw JS Date inside a drizzle sql`` template throws in postgres.js.
  const quietSince = sql`
    ${declarations.declaredAt} <= ${cutoff.toISOString()}::timestamptz
    and not exists (
      select 1 from events e
      where e.type = 'flag.raised' and e.server_id = ${declarations.serverId}
        and e.payload->>'poleKey' = ${declarations.poleKey}
        and e.payload->>'dayzId' = ${declarations.ownerDayzId}
        and e.occurred_at > ${cutoff.toISOString()}::timestamptz
    )`;

  const stale = await db.select({ dayzId: declarations.ownerDayzId, poleKey: declarations.poleKey })
    .from(declarations)
    .where(and(eq(declarations.serverId, serverId), isNotNull(declarations.ownerDayzId), quietSince));

  const lapsed: { dayzId: string; poleKey: string }[] = [];
  for (const s of stale) {
    // One transaction each: a release that deadlocks or loses a race to a
    // concurrent release must not take the rest of the sweep with it, and
    // `releaseTx` returning false is exactly that "someone else got there
    // first" case — nobody to tell.
    const done = await db.transaction(async (tx) => {
      // ⚠️ The predicate is re-checked under FOR UPDATE before releasing. The
      // sweep's select above is not the decision: a raise ingested between
      // that select and this transaction makes the declarant live again, and
      // releasing them anyway would take a base away from a player who was
      // standing at their own flag — with nothing anywhere saying why.
      const [still] = await tx.select({ id: declarations.id })
        .from(declarations)
        .where(and(
          eq(declarations.serverId, serverId),
          eq(declarations.ownerDayzId, s.dayzId!),
          quietSince,
        ))
        .for("update");
      if (!still) return false;
      return releaseTx(tx, { dayzId: s.dayzId!, serverId }, now);
    });
    if (done) lapsed.push({ dayzId: s.dayzId!, poleKey: s.poleKey });
  }
  return lapsed;
}

/**
 * Rule 2: every raised, undeclared pole past its grace, with the flag flying
 * there (spec §4.2). Texture-agnostic on purpose — see the test.
 */
export async function publicPoles(db: Database | Tx, serverId: number, now: Date) {
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
