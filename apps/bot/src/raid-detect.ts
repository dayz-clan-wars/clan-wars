import type { Database } from "@factions/db";
import { declarations, events, factionMembers, factionTextures, factions, membershipHistory, playerSessions, raids } from "@factions/db";
import { HOLDING_STATUSES, type RaidFact } from "@factions/domain";
import { and, asc, desc, eq, exists, gt, inArray, isNull, lte, or, sql } from "drizzle-orm";
import { membershipAt } from "./membership-tick.js";

type Tx = Parameters<Parameters<Database["transaction"]>[0]>[0];

export type LowerVerdict =
  | { kind: "none" }
  | { kind: "raid"; victimFactionId: number; away: boolean };

export type LowerEvent = { serverId: number; occurredAt: Date; dayzId: string; poleKey: string; texture: string };

/**
 * Which statuses can be a raid's victim. Live is the rule (spec §1: dormant
 * and reserved clans are unraidable). Replay (Task 6's season rescore) widens
 * to every holding status because nothing records what a clan's status WAS at
 * an old lower; ⚠️ never pass `replay` from the live consumer, or dormant
 * clans start bleeding points.
 */
function victimStatuses(replay: boolean): readonly string[] {
  return replay ? HOLDING_STATUSES : ["active"];
}

/**
 * Was `dayzId` a full member of `factionId` at `at`? History first (the kills
 * consumer's source, and the only one a replay can trust). Live also accepts
 * today's roster: ⚠️ without it a member whose span the reconciler has not
 * opened yet (it runs once per tick) would read as a stranger, and a clan
 * lowering its own flag would score as a raid on itself.
 */
async function wasMember(tx: Tx, serverId: number, factionId: number, dayzId: string, at: Date, replay: boolean): Promise<boolean> {
  if ((await membershipAt(tx, serverId, dayzId, at)) === factionId) return true;
  if (replay) return false;
  const [row] = await tx.select({ id: factionMembers.id }).from(factionMembers)
    .where(and(eq(factionMembers.factionId, factionId), eq(factionMembers.dayzId, dayzId), eq(factionMembers.status, "full")));
  return row !== undefined;
}

/**
 * The latest `flag.raised` of this texture on this pole at or before `at`.
 *
 * ⚠️ The type literal and the two payload keys are the same statements as
 * `events_raise_lookup_idx` (`server_id, payload->>'poleKey',
 * payload->>'texture', occurred_at` where `type = 'flag.raised'`). Spell any of
 * them differently and the lookup still answers correctly, just by filtering
 * every raise on the server once per lowered flag. Pinned by
 * `dormancy-index-drift.test.ts`, which is why this is exported.
 */
export function raiseLookupQuery(tx: Tx | Database, serverId: number, poleKey: string, texture: string, at: Date) {
  return tx.select({ dayzId: sql<string>`${events.payload}->>'dayzId'`, occurredAt: events.occurredAt }).from(events)
    .where(and(
      eq(events.type, "flag.raised"),
      eq(events.serverId, serverId),
      sql`${events.payload}->>'poleKey' = ${poleKey}`,
      sql`${events.payload}->>'texture' = ${texture}`,
      lte(events.occurredAt, at),
    ))
    .orderBy(desc(events.occurredAt), desc(events.id))
    .limit(1);
}

/**
 * The clan whose own flag this was: raised (latest raise, spec §2) by a full
 * member of X at the raise instant, X eligible, and the texture X's at that
 * instant. Attributes to the RAISER's clan, never to whoever holds the texture
 * today: after a rebrand the texture can belong to someone else.
 */
async function raiserClan(tx: Tx, ev: LowerEvent, replay: boolean): Promise<number | null> {
  const [raise] = await raiseLookupQuery(tx, ev.serverId, ev.poleKey, ev.texture, ev.occurredAt);
  if (!raise?.dayzId) return null;
  const x = await membershipAt(tx, ev.serverId, raise.dayzId, raise.occurredAt);
  if (x === null) return null;
  // ⚠️ The texture check is what keeps a white flag (or a rival's flag a
  // member of X happened to raise) from counting as X's. Without it every
  // abandoned white flag a clan member ever raised becomes a raid on them.
  const [ok] = await tx.select({ id: factions.id }).from(factions)
    .where(and(
      eq(factions.id, x),
      inArray(factions.status, [...victimStatuses(replay)]),
      exists(tx.select({ one: sql`1` }).from(factionTextures).where(and(
        eq(factionTextures.factionId, x),
        eq(factionTextures.texture, ev.texture),
        lte(factionTextures.fromAt, raise.occurredAt),
        or(isNull(factionTextures.toAt), gt(factionTextures.toAt, raise.occurredAt)),
      ))),
    ));
  return ok ? x : null;
}

/**
 * Who this flag.lowered raids, per spec §2. Reads only; takes no locks: the
 * caller locks the victim's `factions` row afterwards (lock order §4.12), and
 * must recheck the victim's status under that lock.
 *
 * The order is the spec's, and it matters:
 *  1. An eligible clan Y's declared base, lowered by a non-member of Y: a raid
 *     on Y at base, whatever flag was flying. One lowering is never two raids,
 *     so a third clan lowering X's flag on Y's pole raids Y and nothing on X.
 *  2. Y's base, lowered by Y's own member: a raid on X (away) only if it was
 *     X's own flag raised by X's member. Otherwise upkeep.
 *  3. Not a declared base: the same raise lookup; a raid on X (away) when the
 *     lowerer is not X's member.
 *
 * "Declared" means a `declarations` row with `declared_at <= occurredAt`, so a
 * replay does not treat a pole as a base before it became one.
 */
export async function classifyLower(tx: Tx, ev: LowerEvent, opts: { replay?: boolean } = {}): Promise<LowerVerdict> {
  const replay = opts.replay ?? false;
  const [base] = await tx.select({ factionId: factions.id }).from(declarations)
    .innerJoin(factions, eq(factions.id, declarations.ownerFactionId))
    .where(and(
      eq(declarations.serverId, ev.serverId),
      eq(declarations.poleKey, ev.poleKey),
      lte(declarations.declaredAt, ev.occurredAt),
      inArray(factions.status, [...victimStatuses(replay)]),
    ));
  if (base) {
    const y = base.factionId;
    if (!(await wasMember(tx, ev.serverId, y, ev.dayzId, ev.occurredAt, replay))) {
      return { kind: "raid", victimFactionId: y, away: false };
    }
    const x = await raiserClan(tx, ev, replay);
    if (x === null || x === y) return { kind: "none" };
    return { kind: "raid", victimFactionId: x, away: true };
  }
  const x = await raiserClan(tx, ev, replay);
  if (x === null) return { kind: "none" };
  if (await wasMember(tx, ev.serverId, x, ev.dayzId, ev.occurredAt, replay)) return { kind: "none" };
  return { kind: "raid", victimFactionId: x, away: true };
}

/** Every raid row of the season, as the value rule's input. Order is irrelevant to `clanValue`; id order keeps it stable. */
export async function seasonRaidFacts(tx: Tx, seasonId: number): Promise<RaidFact[]> {
  const rows = await tx.select({ id: raids.id, at: raids.firstLowerAt, raiderFactionId: raids.raiderFactionId, victimFactionId: raids.victimFactionId })
    .from(raids).where(eq(raids.seasonId, seasonId)).orderBy(asc(raids.id));
  return rows;
}

/**
 * Spec §1 "online": some full member of the clan (membership_history at `at`)
 * had an open `player_sessions` row on this server at `at`, anywhere on the
 * map. `disconnected_at` is exclusive, matching the membership spans.
 */
export async function clanOnlineAt(tx: Tx, serverId: number, factionId: number, at: Date): Promise<boolean> {
  const [row] = await tx.select({ one: sql<number>`1` }).from(membershipHistory)
    .innerJoin(playerSessions, and(eq(playerSessions.serverId, membershipHistory.serverId), eq(playerSessions.dayzId, membershipHistory.dayzId)))
    .where(and(
      eq(membershipHistory.serverId, serverId),
      eq(membershipHistory.factionId, factionId),
      lte(membershipHistory.joinedAt, at),
      or(isNull(membershipHistory.leftAt), gt(membershipHistory.leftAt, at)),
      lte(playerSessions.connectedAt, at),
      or(isNull(playerSessions.disconnectedAt), gt(playerSessions.disconnectedAt, at)),
    ))
    .limit(1);
  return row !== undefined;
}
