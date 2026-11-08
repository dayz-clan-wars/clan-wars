import type { Database } from "@factions/db";
import { consumerCursors, declarations, events, factionMembers, factions, poles, publicBaseBounties, seasonStandings, servers } from "@factions/db";
import { readCursor, writeCursor, readEventBatch } from "@factions/event-log";
import { PUBLIC_BASE_BOUNTY_POINTS, PUBLIC_BASE_DESPAWN_MS, WATCH_ZONE_RADIUS_M, distance2d, scoringWeekStartOf } from "@factions/domain";
import { noticeClanTx } from "@factions/roster/internal";
import { and, desc, eq, gte, lt, sql } from "drizzle-orm";
import { openSeason } from "./season.js";

/** ⚠️ Distinct from every other consumer name; two consumers sharing a cursor skip each other's events. */
export const PUBLIC_BOUNTY_CONSUMER = "public-bounty-consumer";

export type PublicBountyResult = { scanned: number; claimed: number; penalties: number };

type Tx = Parameters<Parameters<Database["transaction"]>[0]>[0];
type FlagPayload = { dayzId: string; gamertag: string; poleKey: string };

function readFlagPayload(payload: unknown): FlagPayload | null {
  if (typeof payload !== "object" || payload === null) return null;
  const p = payload as Record<string, unknown>;
  if (typeof p.dayzId !== "string" || typeof p.gamertag !== "string" || typeof p.poleKey !== "string" || p.poleKey === "") return null;
  return { dayzId: p.dayzId, gamertag: p.gamertag, poleKey: p.poleKey };
}

/**
 * Was this pole a public base at the moment of the event? The same test the
 * public-bases layer applies (`publicPoles`), evaluated at event time:
 * undeclared, nothing declared within the watch zone, past its grace. A
 * LOWER also needs the flag to have been up recently enough to still be on
 * the map — a raise within PUBLIC_BASE_DESPAWN_MS before it.
 */
async function wasPublic(tx: Tx, ev: { id: number; serverId: number; occurredAt: Date; type: string }, poleKey: string): Promise<boolean> {
  const [pole] = await tx.select({ x: poles.x, z: poles.z, graceUntil: poles.graceUntil })
    .from(poles)
    .innerJoin(servers, and(eq(servers.id, poles.serverId), eq(servers.map, poles.map)))
    .where(and(eq(poles.serverId, ev.serverId), eq(poles.poleKey, poleKey)));
  if (!pole || pole.graceUntil >= ev.occurredAt) return false;

  const declared = await tx.select({ poleKey: declarations.poleKey, x: declarations.x, z: declarations.z })
    .from(declarations).where(eq(declarations.serverId, ev.serverId));
  const here = { x: Number(pole.x), z: Number(pole.z) };
  if (declared.some((d) => d.poleKey === poleKey || distance2d(here, { x: Number(d.x), z: Number(d.z) }) < WATCH_ZONE_RADIUS_M)) return false;

  if (ev.type === "flag.lowered") {
    const [lastRaise] = await tx.select({ id: events.id }).from(events).where(and(
      eq(events.type, "flag.raised"),
      eq(events.serverId, ev.serverId),
      sql`${events.payload}->>'poleKey' = ${poleKey}`,
      lt(events.id, ev.id),
      gte(events.occurredAt, new Date(ev.occurredAt.getTime() - PUBLIC_BASE_DESPAWN_MS)),
    )).orderBy(desc(events.id)).limit(1);
    if (!lastRaise) return false;
  }
  return true;
}

/**
 * Points for public bases. A full member of an ACTIVE clan who lowers the
 * flag on a public base earns the clan +PUBLIC_BASE_BOUNTY_POINTS, once per
 * base per clan. A full member of an active or dormant clan who raises a
 * flag on one costs the clan the same, every time. Solo players have no
 * points and are skipped. Both count toward the season total and the weekly
 * Alpha ranking (`weekTopThree`).
 *
 * ⚠️ Starts at the head of the log on first run: with no cursor row it seeds
 * one at the newest event and scores nothing, so deploying this never pays
 * out retroactively for lowers that happened before the rule existed.
 *
 * ⚠️ Lock order (§4.12): season_standings before the ledger row, clan
 * notices last — the same order raid-tick uses for standings → raids.
 */
export async function publicBountyTick(db: Database, opts: { batchSize?: number } = {}): Promise<PublicBountyResult> {
  const out: PublicBountyResult = { scanned: 0, claimed: 0, penalties: 0 };
  const [seeded] = await db.select({ id: consumerCursors.lastEventId }).from(consumerCursors).where(eq(consumerCursors.consumerName, PUBLIC_BOUNTY_CONSUMER));
  if (!seeded) {
    const [head] = await db.select({ id: sql<number>`coalesce(max(${events.id}), 0)`.mapWith(Number) }).from(events);
    await writeCursor(db, PUBLIC_BOUNTY_CONSUMER, head?.id ?? 0);
    return out;
  }

  const batchSize = opts.batchSize ?? 500;
  let cursor = await readCursor(db, PUBLIC_BOUNTY_CONSUMER);
  for (;;) {
    const batch = await readEventBatch(db, cursor, batchSize);
    if (batch.length === 0) break;
    for (const ev of batch) {
      cursor = ev.id;
      if (ev.type !== "flag.raised" && ev.type !== "flag.lowered") continue;
      const p = readFlagPayload(ev.payload);
      if (!p) continue;
      out.scanned++;
      const r = await db.transaction(async (tx) => {
        const done = async <T,>(v: T): Promise<T> => { await writeCursor(tx, PUBLIC_BOUNTY_CONSUMER, ev.id); return v; };
        const lowered = ev.type === "flag.lowered";

        const [clan] = await tx.select({ id: factions.id, status: factions.status }).from(factions)
          .innerJoin(factionMembers, eq(factionMembers.factionId, factions.id))
          .where(and(
            eq(factions.serverId, ev.serverId), sql`${factions.status} in ('active','dormant')`,
            eq(factionMembers.dayzId, p.dayzId), eq(factionMembers.status, "full"),
          ));
        if (!clan) return done(null);
        if (lowered && clan.status !== "active") return done(null); // only active clans score, as with raids

        if (!await wasPublic(tx, ev, p.poleKey)) return done(null);
        const season = await openSeason(tx, ev.serverId);
        if (!season) return done(null);

        if (lowered) {
          const [already] = await tx.select({ id: publicBaseBounties.id }).from(publicBaseBounties).where(and(
            eq(publicBaseBounties.factionId, clan.id), eq(publicBaseBounties.serverId, ev.serverId),
            eq(publicBaseBounties.poleKey, p.poleKey), eq(publicBaseBounties.kind, "claimed"),
          ));
          if (already) return done(null);
        }
        const [replayed] = await tx.select({ id: publicBaseBounties.id }).from(publicBaseBounties).where(eq(publicBaseBounties.eventId, ev.id));
        if (replayed) return done(null);

        const points = lowered ? PUBLIC_BASE_BOUNTY_POINTS : -PUBLIC_BASE_BOUNTY_POINTS;
        await tx.insert(seasonStandings).values({ seasonId: season.id, factionId: clan.id, points })
          .onConflictDoUpdate({ target: [seasonStandings.seasonId, seasonStandings.factionId], set: { points: sql`${seasonStandings.points} + ${points}` } });
        await tx.insert(publicBaseBounties).values({
          seasonId: season.id, serverId: ev.serverId, factionId: clan.id, poleKey: p.poleKey, dayzId: p.dayzId,
          kind: lowered ? "claimed" : "penalty", points, eventId: ev.id, occurredAt: ev.occurredAt,
          weekStart: scoringWeekStartOf(ev.occurredAt),
        });
        // No coordinates in the payload (clan_notices CHECK).
        await noticeClanTx(tx, {
          serverId: ev.serverId, factionId: clan.id, kind: lowered ? "public_bounty" : "public_penalty",
          occurredAt: ev.occurredAt, payload: { gamertag: p.gamertag, points },
        });
        return done(lowered ? "claimed" as const : "penalty" as const);
      });
      if (r === "claimed") out.claimed++;
      else if (r === "penalty") out.penalties++;
    }
  }
  return out;
}
