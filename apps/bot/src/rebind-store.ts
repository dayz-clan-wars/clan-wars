import type { Database } from "@factions/db";
import { factions, factionMembers, events, declarations } from "@factions/db";
import { and, eq, gte, inArray, isNull, lte, or, sql } from "drizzle-orm";
import { leaderIs } from "./roster-store.js";
import type { QualifyingRaise } from "./rebind.js";
import { appendFactionEventTx } from "./feed-store.js";
import { actorGamertagTx } from "./feed-actor.js";
import { declareTx, releaseTx } from "./declaration-store.js";

/**
 * The statuses a faction may rebind FROM.
 *
 * ⚠️ Deliberately NOT HOLDING_STATUSES. `reserved` is a holding status but has
 * never activated — its own 24h reservation lapse is the right path for it —
 * and `lapsed`/`disbanded` are terminal, with their flag and tag already back
 * in the pool. Reusing HOLDING here would let a reserved faction skip its
 * activation ritual by rebinding.
 */
const REBINDABLE: string[] = ["active", "dormant"];

/**
 * The reason a `rebind` call unwinds without moving anything.
 *
 * ⚠️ Mirrors faction-store's `ReserveAbort`: the outcome (not just the
 * failure) is threaded back out through the exception so this transaction
 * unwinds exactly the way a caught unique-violation does, and the caller
 * gets a decision rather than a generic throw.
 */
class RebindAbort extends Error {
  constructor(readonly outcome: "refused" | "too-close") { super(outcome); }
}

/** The faction fields a rebind decision needs. */
export type RebindTarget = {
  id: number;
  serverId: number;
  name: string;
  tag: string;
  texture: string;
  /** Null only if the faction somehow has no declaration — never true for active/dormant. */
  poleKey: string | null;
  status: string;
  reboundAt: Date | null;
};

export type RebindArgs = {
  factionId: number;
  leaderDiscordId: string;
  /** The pole the candidate list was built against — see the guard below. */
  expectedPoleKey: string;
  poleKey: string;
  x: number;
  y: number;
  z: number;
  /** The `flag.raised` event that named this pole — declareTx's evidence. */
  evidenceEventId: number;
  at: Date;
  /** `at - REBIND_COOLDOWN_MS`. A rebind is allowed when rebound_at <= this. */
  notBefore: Date;
};

export interface RebindStore {
  factionFor(factionId: number): Promise<RebindTarget | null>;
  qualifyingRaises(faction: RebindTarget, since: Date): Promise<QualifyingRaise[]>;
  rebind(a: RebindArgs): Promise<"ok" | "refused" | "too-close">;
}

export class PgRebindStore implements RebindStore {
  constructor(private readonly db: Database) {}

  async factionFor(factionId: number): Promise<RebindTarget | null> {
    // Left-join: the pole binding lives in `declarations` now, not on
    // `factions` itself (spec §4.1, base-declaration design §8 option C).
    const [row] = await this.db.select({
      id: factions.id, serverId: factions.serverId,
      name: factions.name, tag: factions.tag, texture: factions.texture,
      poleKey: declarations.poleKey, status: factions.status, reboundAt: factions.reboundAt,
    }).from(factions)
      .leftJoin(declarations, eq(declarations.ownerFactionId, factions.id))
      .where(eq(factions.id, factionId));
    return row ?? null;
  }

  /**
   * Raises that could name a new pole for this faction.
   *
   * ⚠️ Read from `events`, NOT from `poles` or `flag_changes`. The projector
   * that fills those does not run against the live database — `flag_changes`
   * holds zero rows there — so a read model would report no raises at all.
   * `ceremony-tick` and the dormancy clock read the event log for this reason.
   *
   * ⚠️ Bounded by `occurred_at >= since`, which is what makes this cheap: it
   * rides `events_server_occurred_idx` on (server_id, occurred_at). It does
   * NOT use `events_raise_lookup_idx`, whose leading column after server_id is
   * poleKey — and this query constrains poleKey with an inequality, not an
   * equality, so that index cannot be walked. With a one-hour window that is
   * fine; do not widen the window without re-checking the plan.
   */
  async qualifyingRaises(faction: RebindTarget, since: Date): Promise<QualifyingRaise[]> {
    const poleKey = sql<string>`${events.payload}->>'poleKey'`;
    const dayzId = sql<string>`${events.payload}->>'dayzId'`;

    const rows = await this.db.select({
      poleKey,
      dayzId,
      gamertag: sql<string>`${events.payload}->>'gamertag'`,
      x: sql<string>`${events.payload}->'pole'->>'x'`,
      y: sql<string>`${events.payload}->'pole'->>'y'`,
      z: sql<string>`${events.payload}->'pole'->>'z'`,
      occurredAt: events.occurredAt,
      eventId: events.id,
    }).from(events).where(and(
      eq(events.type, "flag.raised"),
      eq(events.serverId, faction.serverId),
      gte(events.occurredAt, since),
      // The faction's OWN colours. A rebind is planting your flag somewhere
      // new, not founding something, so Flag_White is not involved.
      sql`${events.payload}->>'texture' = ${faction.texture}`,
      // Never the pole it already holds — see selectCandidates' comment.
      // ⚠️ Conditional: `faction.poleKey` is null only when the faction has
      // no declaration at all, which REBINDABLE factions never do in
      // practice — but the type is nullable (left join), and `<> NULL` in
      // SQL is never true, which would silently exclude EVERY raise rather
      // than none, so a plain `sql\`true\`` here is the correct no-op.
      faction.poleKey === null ? sql`true` : sql`${events.payload}->>'poleKey' <> ${faction.poleKey}`,
      // ⚠️ Roster members only. This is the security boundary of the whole
      // command: a rebind moves the faction's identity to coordinates of
      // someone's choosing, so a stranger's raise must never supply one.
      sql`exists (select 1 from ${factionMembers}
                  where ${factionMembers.factionId} = ${faction.id}
                    and ${factionMembers.dayzId} = ${events.payload}->>'dayzId')`,
      // Not a pole ANYONE has declared — clan or solo alike. The pole
      // binding lives in `declarations` now, not on `factions`.
      sql`not exists (select 1 from ${declarations} d
                      where d.server_id = ${faction.serverId}
                        and d.pole_key = ${events.payload}->>'poleKey')`,
    ));

    // ⚠️ jsonb text extraction yields strings. Without Number() the
    // coordinates would be written to numeric columns as text and every later
    // arithmetic on them would concatenate — the same trap the supply tick
    // documents for drizzle's numeric columns.
    return rows.map((r) => ({
      poleKey: r.poleKey,
      x: Number(r.x), y: Number(r.y), z: Number(r.z),
      dayzId: r.dayzId,
      gamertag: r.gamertag,
      occurredAt: r.occurredAt,
      eventId: r.eventId,
    }));
  }

  /**
   * Move the binding, in one guarded statement.
   *
   * ⚠️ Every precondition rides in the WHERE clause rather than a read before
   * the write: leadership, status, the cooldown, and the pole the candidate
   * list was built against. Two leaders confirming two different candidates
   * concurrently must produce one move and one refusal — a read-then-write
   * would produce two moves, and the second would silently overwrite the first.
   *
   * ⚠️ Wrapped in a transaction so the feed row shares that guard, and the
   * payload carries NO coordinates: a rebind post says a faction moved, never
   * where from or to. `faction_events_no_coordinates` would reject them, but
   * this is the one transition whose whole subject is a location, so it is
   * also the one place the omission has to be deliberate.
   *
   * ⚠️ The pole binding no longer lives on `factions` — it's a `declarations`
   * row now, so a rebind is release-then-declare, not an UPDATE of columns
   * here. The `factions` UPDATE below still carries every OTHER guard
   * (leadership, status, cooldown, optimistic concurrency), and it runs
   * FIRST — lock order (spec §4.12) is `factions` before `declarations`, and
   * `declareTx`/`releaseTx` both assume the caller already holds `factions`
   * if it holds anything.
   */
  async rebind(a: RebindArgs): Promise<"ok" | "refused" | "too-close"> {
    return this.db.transaction(async (tx) => {
      // Read before the update overwrites it, the way `rename` reads the
      // previous name. This is a plain SELECT on the primary key that the
      // update's own WHERE below also pins, so it cannot observe a row other
      // than the one the update then touches (or fails to).
      const [before] = await tx.select({ status: factions.status })
        .from(factions).where(eq(factions.id, a.factionId));

      // The guard rides the factions update (lock order: factions first).
      const [row] = await tx.update(factions)
        .set({ status: "active", dormantSince: null, reboundAt: a.at })
        .where(and(
          eq(factions.id, a.factionId),
          leaderIs(a.factionId, a.leaderDiscordId),
          inArray(factions.status, REBINDABLE),
          or(isNull(factions.reboundAt), lte(factions.reboundAt, a.notBefore)),
          // Optimistic concurrency, now against the declaration the
          // candidates were built from — the pole must still be the one the
          // candidate list was computed against.
          sql`exists (select 1 from ${declarations} d where d.owner_faction_id = ${factions.id} and d.pole_key = ${a.expectedPoleKey})`,
        ))
        .returning({ id: factions.id, serverId: factions.serverId, name: factions.name, tag: factions.tag, texture: factions.texture });
      if (!row) return "refused";

      // Release, then declare. ⚠️ Release first, or the clan's own old row
      // trips declarations_faction_uniq — and the 200 m check must not see
      // the old pole either, since a clan may move 150 m down the road.
      await releaseTx(tx, { factionId: a.factionId }, a.at);
      const declared = await declareTx(tx, {
        serverId: row.serverId, poleKey: a.poleKey, x: a.x, y: a.y, z: a.z,
        owner: { factionId: a.factionId }, evidence: { eventId: a.evidenceEventId }, at: a.at,
      });
      // ⚠️ owner-has-base is unreachable right here: releaseTx just deleted
      // this faction's only declaration, and declareTx's own uniqueness
      // check runs inside this same transaction, so there is nothing left
      // for the clan to already own. pole-taken means another declarer won
      // the target pole in the window between qualifyingRaises and this
      // call — reported the same as any other refusal.
      if (!declared.ok) throw new RebindAbort(declared.reason === "too-close" ? "too-close" : "refused");

      const actor = await actorGamertagTx(tx, a.leaderDiscordId);

      await appendFactionEventTx(tx, {
        serverId: row.serverId, factionId: row.id, kind: "rebound", occurredAt: a.at,
        payload: { name: row.name, tag: row.tag, texture: row.texture, actor },
      });

      // ⚠️ A dormant faction that rebinds is also revived by this same
      // update (status -> active, dormantSince -> null) — REBINDABLE
      // includes "dormant" precisely so a faction can escape dormancy this
      // way. Without this second row, the channel shows "gone dormant …"
      // followed by "moved its base" and never says the countdown was
      // cancelled or that supplies resume. Appended AFTER `rebound` — the
      // move happened, and the revival is its consequence — so `id` order
      // tells the story in the right sequence.
      if (before?.status === "dormant") {
        await appendFactionEventTx(tx, {
          serverId: row.serverId, factionId: row.id, kind: "revived", occurredAt: a.at,
          payload: { name: row.name, tag: row.tag, texture: row.texture, actor },
        });
      }

      return "ok";
    }).catch((err) => {
      if (err instanceof RebindAbort) return err.outcome;
      throw err;
    });
  }
}
