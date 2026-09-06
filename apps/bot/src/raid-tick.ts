import type { Database } from "@factions/db";
import { declarations, factionMembers, factions, raids, seasonStandings } from "@factions/db";
import { readCursor, writeCursor, readEventBatch } from "@factions/event-log";
import { RAID_DEDUP_MS, pointsFor, weekStartOf } from "@factions/domain";
import { appendWarLogTx, noticeClanTx, noticeFullMembersTx } from "@factions/roster/internal";
import { and, desc, asc, eq, gt, isNull, sql } from "drizzle-orm";
import { openSeason } from "./season.js";

/** ⚠️ Distinct from every other consumer name; two consumers sharing a cursor skip each other's events. */
export const RAID_CONSUMER = "raid-consumer";

export type RaidTickResult = { scanned: number; raids: number; absorbed: number; skippedNoSeason: number };

type FlagPayload = { dayzId: string; gamertag: string; texture: string; poleKey: string };
function readFlagPayload(payload: unknown): FlagPayload | null {
  if (typeof payload !== "object" || payload === null) return null;
  const p = payload as Record<string, unknown>;
  if (typeof p.dayzId !== "string" || typeof p.gamertag !== "string" || typeof p.texture !== "string" || typeof p.poleKey !== "string") return null;
  return { dayzId: p.dayzId, gamertag: p.gamertag, texture: p.texture, poleKey: p.poleKey };
}

/**
 * The raid consumer (spec §5.8, §7, §8.2). A `flag.lowered` at a declared
 * ACTIVE clan pole by someone who is not a full member of that clan is a
 * raid: one row per (raider clan, victim) per 24 h from the first lower;
 * later lowers inside the window update `last_lower_at`/`last_lower_event_id`/
 * `lower_count` and score nothing. Everything happens under the victim's
 * `factions` row lock, then `season_standings`, then `raids`, then the
 * war-log row and the notices — last, per §4.12.
 */
export async function raidTick(db: Database, opts: { batchSize?: number; onNoSeason?: (serverId: number) => void } = {}): Promise<RaidTickResult> {
  const batchSize = opts.batchSize ?? 500;
  const out: RaidTickResult = { scanned: 0, raids: 0, absorbed: 0, skippedNoSeason: 0 };
  let cursor = await readCursor(db, RAID_CONSUMER);
  const warned = new Set<number>();
  for (;;) {
    const batch = await readEventBatch(db, cursor, batchSize);
    if (batch.length === 0) break;
    for (const ev of batch) {
      cursor = ev.id;
      if (ev.type !== "flag.lowered") continue;
      const p = readFlagPayload(ev.payload);
      if (!p) continue;
      out.scanned++;
      const result = await db.transaction(async (tx) => {
        // The victim: the ACTIVE clan whose declaration is this pole. FOR UPDATE on factions first (§4.12).
        const [victim] = await tx.select({ id: factions.id, name: factions.name, tag: factions.tag, texture: factions.texture, flagDownSince: factions.flagDownSince, activatedAt: factions.activatedAt })
          .from(factions).innerJoin(declarations, eq(declarations.ownerFactionId, factions.id))
          .where(and(eq(factions.serverId, ev.serverId), eq(declarations.poleKey, p.poleKey), eq(factions.status, "active")))
          .for("update", { of: factions });
        if (!victim) return "no-raid" as const;
        const [member] = await tx.select({ id: factionMembers.id }).from(factionMembers)
          .where(and(eq(factionMembers.factionId, victim.id), eq(factionMembers.dayzId, p.dayzId), eq(factionMembers.status, "full")));
        if (member) return "no-raid" as const; // upkeep, not a raid
        const season = await openSeason(tx, ev.serverId);
        if (!season) return "no-season" as const;
        // The raider's clan, if any (full membership on this server).
        const [raider] = await tx.select({ factionId: factionMembers.factionId, name: factions.name, tag: factions.tag }).from(factionMembers)
          .innerJoin(factions, eq(factions.id, factionMembers.factionId))
          .where(and(eq(factionMembers.serverId, ev.serverId), eq(factionMembers.dayzId, p.dayzId), eq(factionMembers.status, "full")));
        const raiderFactionId = raider?.factionId ?? null;
        // Dedup under the victim's lock (§8.2).
        const since = new Date(ev.occurredAt.getTime() - RAID_DEDUP_MS);
        const [open] = await tx.select({ id: raids.id, lastLowerEventId: raids.lastLowerEventId }).from(raids).where(and(
          eq(raids.victimFactionId, victim.id), gt(raids.firstLowerAt, since),
          raiderFactionId === null ? and(isNull(raids.raiderFactionId), eq(raids.raiderDayzId, p.dayzId))! : eq(raids.raiderFactionId, raiderFactionId),
        )).orderBy(desc(raids.firstLowerAt)).limit(1);
        if (open) {
          // ⚠️ `ev.id` is the true idempotency guard here, not `lastLowerAt`.
          // A redelivery of an event already folded into this raid (any
          // at-least-once replay, not only a crash — see raid-tick.ts's
          // header) carries an id no greater than `lastLowerEventId`; taking
          // the absorb branch again for it would double-count `lower_count`.
          // Only a genuinely new lower (`ev.id` strictly greater) advances
          // the row; an already-applied replay is a no-op.
          if (ev.id > open.lastLowerEventId) {
            await tx.update(raids).set({ lastLowerAt: ev.occurredAt, lastLowerEventId: ev.id, lowerCount: sql`${raids.lowerCount} + 1` }).where(eq(raids.id, open.id));
          }
          return "absorbed" as const;
        }
        // Points from the ladder at this moment (§8.1): ranked = active clans with points > 0 this season.
        const ranked = await tx.select({ factionId: seasonStandings.factionId }).from(seasonStandings)
          .innerJoin(factions, eq(factions.id, seasonStandings.factionId))
          .where(and(eq(seasonStandings.seasonId, season.id), eq(factions.status, "active"), gt(seasonStandings.points, 0)))
          .orderBy(desc(seasonStandings.points), asc(seasonStandings.timesRaided), asc(factions.activatedAt));
        const idx = ranked.findIndex((r) => r.factionId === victim.id);
        const rank = idx === -1 ? null : idx + 1;
        const points = raiderFactionId === null ? 0 : pointsFor(rank, ranked.length);
        // Standings before raids, per §4.12's documented lock order.
        await tx.insert(seasonStandings).values({ seasonId: season.id, factionId: victim.id, timesRaided: 1 })
          .onConflictDoUpdate({ target: [seasonStandings.seasonId, seasonStandings.factionId], set: { timesRaided: sql`${seasonStandings.timesRaided} + 1` } });
        if (raiderFactionId !== null) {
          await tx.insert(seasonStandings).values({ seasonId: season.id, factionId: raiderFactionId, points, raids: 1 })
            .onConflictDoUpdate({ target: [seasonStandings.seasonId, seasonStandings.factionId], set: { points: sql`${seasonStandings.points} + ${points}`, raids: sql`${seasonStandings.raids} + 1` } });
        }
        await tx.insert(raids).values({
          seasonId: season.id, serverId: ev.serverId, victimFactionId: victim.id, raiderDayzId: p.dayzId, raiderFactionId,
          firstLowerEventId: ev.id, firstLowerAt: ev.occurredAt, lastLowerAt: ev.occurredAt, lastLowerEventId: ev.id, lowerCount: 1,
          points, victimRankAtLower: rank, rankedCountAtLower: ranked.length, weekStart: weekStartOf(ev.occurredAt),
        });
        // The clock starts on the FIRST lower of an episode; a second raid during flag-down does not restart it.
        if (victim.flagDownSince === null) {
          await tx.update(factions).set({ flagDownSince: ev.occurredAt, flagDownByDayzId: p.dayzId }).where(eq(factions.id, victim.id));
        }
        const payload = { raiderClan: raider?.name ?? null, raiderTag: raider?.tag ?? null, victimClan: victim.name, victimTag: victim.tag, gamertag: p.gamertag, solo: raider === undefined, points };
        await appendWarLogTx(tx, { serverId: ev.serverId, kind: "raid", occurredAt: ev.occurredAt, payload });
        if (victim.flagDownSince === null) {
          const notice = { gamertag: p.gamertag, raiderClan: raider?.name ?? null };
          await noticeClanTx(tx, { serverId: ev.serverId, factionId: victim.id, kind: "flag_down", occurredAt: ev.occurredAt, payload: notice });
          await noticeFullMembersTx(tx, { serverId: ev.serverId, factionId: victim.id, kind: "flag_down", occurredAt: ev.occurredAt, payload: notice });
        }
        return "raid" as const;
      });
      if (result === "raid") out.raids++;
      else if (result === "absorbed") out.absorbed++;
      else if (result === "no-season") {
        out.skippedNoSeason++;
        if (!warned.has(ev.serverId)) { warned.add(ev.serverId); opts.onNoSeason?.(ev.serverId); }
      }
    }
    await writeCursor(db, RAID_CONSUMER, cursor);
  }
  return out;
}
