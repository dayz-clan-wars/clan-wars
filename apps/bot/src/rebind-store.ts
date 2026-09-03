import type { Database } from "@factions/db";
import { factions, factionMembers, events } from "@factions/db";
import { and, eq, gte, inArray, isNull, lte, or, sql } from "drizzle-orm";
import { HOLDING_STATUSES } from "@factions/domain";
import { leaderIs } from "./roster-store.js";
import type { QualifyingRaise } from "./rebind.js";

// Widened to a mutable array: HOLDING_STATUSES is `as const` (a readonly
// tuple) so every faction/domain consumer gets full literal-type checking,
// but drizzle's inArray() requires a plain mutable array.
const HOLDING: string[] = [...HOLDING_STATUSES];

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

/** The faction fields a rebind decision needs. */
export type RebindTarget = {
  id: number;
  serverId: number;
  name: string;
  tag: string;
  texture: string;
  poleKey: string;
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
  at: Date;
  /** `at - REBIND_COOLDOWN_MS`. A rebind is allowed when rebound_at <= this. */
  notBefore: Date;
};

export interface RebindStore {
  factionFor(factionId: number): Promise<RebindTarget | null>;
  qualifyingRaises(faction: RebindTarget, since: Date): Promise<QualifyingRaise[]>;
  rebind(a: RebindArgs): Promise<boolean>;
}

export class PgRebindStore implements RebindStore {
  constructor(private readonly db: Database) {}

  async factionFor(factionId: number): Promise<RebindTarget | null> {
    const [row] = await this.db.select({
      id: factions.id, serverId: factions.serverId,
      name: factions.name, tag: factions.tag, texture: factions.texture,
      poleKey: factions.poleKey, status: factions.status, reboundAt: factions.reboundAt,
    }).from(factions).where(eq(factions.id, factionId));
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
    }).from(events).where(and(
      eq(events.type, "flag.raised"),
      eq(events.serverId, faction.serverId),
      gte(events.occurredAt, since),
      // The faction's OWN colours. A rebind is planting your flag somewhere
      // new, not founding something, so Flag_White is not involved.
      sql`${events.payload}->>'texture' = ${faction.texture}`,
      // Never the pole it already holds — see selectCandidates' comment.
      sql`${events.payload}->>'poleKey' <> ${faction.poleKey}`,
      // ⚠️ Roster members only. This is the security boundary of the whole
      // command: a rebind moves the faction's identity to coordinates of
      // someone's choosing, so a stranger's raise must never supply one.
      sql`exists (select 1 from ${factionMembers}
                  where ${factionMembers.factionId} = ${faction.id}
                    and ${factionMembers.dayzId} = ${events.payload}->>'dayzId')`,
      // Not a pole any holding faction already owns.
      sql`not exists (select 1 from ${factions} f
                      where f.server_id = ${faction.serverId}
                        and f.pole_key = ${events.payload}->>'poleKey'
                        and f.status in ${HOLDING})`,
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
   */
  async rebind(a: RebindArgs): Promise<boolean> {
    const rows = await this.db.update(factions)
      .set({
        poleKey: a.poleKey,
        x: a.x.toFixed(2), y: a.y.toFixed(2), z: a.z.toFixed(2),
        status: "active",
        dormantSince: null,
        reboundAt: a.at,
      })
      .where(and(
        eq(factions.id, a.factionId),
        leaderIs(a.factionId, a.leaderDiscordId),
        inArray(factions.status, REBINDABLE),
        // Optimistic concurrency: the pole must still be the one the
        // candidates were computed against.
        eq(factions.poleKey, a.expectedPoleKey),
        or(isNull(factions.reboundAt), lte(factions.reboundAt, a.notBefore)),
      ))
      .returning({ id: factions.id });
    return rows.length > 0;
  }
}
