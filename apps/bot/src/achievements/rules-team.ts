import { ACHIEVEMENT_BY_KEY, CLASS_TILE_KEYS, HOLDING_STATUSES, type AchievementKey, type EarnableKey } from "@factions/domain";
import { achievementUnlocks, alphaWeeks, defenses, events, factions, membershipHistory, raids, seasonResults, seasons } from "@factions/db";
import { isRuinRepair } from "@factions/roster/internal";
import { and, asc, eq, inArray, isNotNull, sql, type SQL } from "drizzle-orm";
import { clanPvpKills, firstsByFirearm } from "./rules-pvp.js";
import { clanId, nth, oneShot, type Rule } from "./types.js";

const T = (k: AchievementKey) => ACHIEVEMENT_BY_KEY[k].target;
const WEEK = 7 * 86_400_000;

async function ownRaids(db: Parameters<Rule>[0], factionId: number) {
  return db.select({ id: raids.id, at: raids.firstLowerAt, serverId: raids.serverId, victim: raids.victimFactionId, victimRank: raids.victimRankAtLower })
    .from(raids).where(eq(raids.raiderFactionId, factionId)).orderBy(asc(raids.firstLowerAt), asc(raids.id));
}
/** A closed season the clan placed in, with the clan's activation, so "whole season" can be checked. */
async function closedSeasons(db: Parameters<Rule>[0], factionId: number) {
  return db.select({
    id: seasonResults.id, rank: seasonResults.rank, timesRaided: seasonResults.timesRaided, statusAtClose: seasonResults.statusAtClose,
    number: seasons.number, startedAt: seasons.startedAt, endedAt: seasons.endedAt, serverId: seasons.serverId, champion: seasons.championFactionId,
  }).from(seasonResults).innerJoin(seasons, eq(seasons.id, seasonResults.seasonId))
    .where(and(eq(seasonResults.factionId, factionId), isNotNull(seasons.endedAt))).orderBy(asc(seasons.endedAt));
}
/**
 * "`dayzId` was a full member of this clan at `at`": a membership_history span with
 * joined_at ≤ at < left_at (open spans run on). The same reading as `membershipAt`
 * (membership-tick.ts), which is how `kills.killer_faction_id` is resolved — so Renovators
 * and Every Class Covered credit a member exactly when Warband and Armory would.
 * ⚠️ `exists`, never a join: a player with two spans in one clan that overlap (the schema allows
 * it for closed spans) would otherwise count the same repair or unlock twice.
 */
const memberAt = (factionId: number, dayzId: SQL, at: SQL, serverId?: SQL) => sql`exists (
  select 1 from ${membershipHistory} mh
  where mh.faction_id = ${factionId} and mh.dayz_id = ${dayzId} and mh.joined_at <= ${at} and (mh.left_at is null or mh.left_at > ${at})
  ${serverId ? sql`and mh.server_id = ${serverId}` : sql``})`;

const raidCount = (key: AchievementKey): Rule => async (db, owner) => nth(await ownRaids(db, clanId(owner)), T(key), (r) => ({ raids: r.length }));

export const TEAM_RULES: Partial<Record<EarnableKey, Rule>> = {
  colors_raised: async (db, owner) => {
    const [f] = await db.select({ id: factions.id, at: factions.activatedAt, serverId: factions.serverId, tag: factions.tag }).from(factions).where(eq(factions.id, clanId(owner)));
    return oneShot(f?.at ? { at: f.at, id: f.id, serverId: f.serverId, evidence: { tag: f.tag } } : undefined);
  },

  full_strength: async (db, owner) => {
    // Sweep line over spans: +1 at each join, −1 at each leave (leaves before joins at the same instant).
    const target = T("full_strength");
    const spans = await db.select({ id: membershipHistory.id, from: membershipHistory.joinedAt, to: membershipHistory.leftAt, serverId: membershipHistory.serverId })
      .from(membershipHistory).where(eq(membershipHistory.factionId, clanId(owner)));
    const points: { t: number; delta: number; span: typeof spans[number] }[] = [];
    for (const s of spans) { points.push({ t: s.from.getTime(), delta: +1, span: s }); if (s.to) points.push({ t: s.to.getTime(), delta: -1, span: s }); }
    points.sort((a, b) => a.t - b.t || a.delta - b.delta);
    let n = 0, best = 0;
    for (const p of points) {
      n += p.delta;
      if (n > best) best = n;
      if (n === target && p.delta > 0) return { count: n, target, earnedAt: new Date(p.t), evidenceId: p.span.id, evidence: { members: n }, serverId: p.span.serverId };
    }
    return { count: best, target };
  },

  first_raid: raidCount("first_raid"),
  warpath: raidCount("warpath"),

  giant_killer: async (db, owner) => {
    const r = (await ownRaids(db, clanId(owner))).find((x) => x.victimRank === 1);
    return oneShot(r ? { at: r.at, id: r.id, serverId: r.serverId, evidence: { victimFactionId: r.victim } } : undefined);
  },

  wide_net: async (db, owner) => {
    const target = T("wide_net");
    const seen = new Set<number>();
    for (const r of await ownRaids(db, clanId(owner))) {
      if (seen.has(r.victim)) continue;
      seen.add(r.victim);
      if (seen.size === target) return { count: target, target, earnedAt: r.at, evidenceId: r.id, evidence: { clans: target }, serverId: r.serverId };
    }
    return { count: seen.size, target };
  },

  fortress: async (db, owner) => {
    const rows = await db.select({ id: defenses.id, at: defenses.defendedAt }).from(defenses).where(eq(defenses.factionId, clanId(owner))).orderBy(asc(defenses.defendedAt), asc(defenses.id));
    return nth(rows, T("fortress"), (r) => ({ defenses: r.length }));
  },

  alpha: async (db, owner) => {
    const [w] = await db.select({ id: alphaWeeks.id, weekStart: alphaWeeks.weekStart, rank: alphaWeeks.rank }).from(alphaWeeks)
      .where(eq(alphaWeeks.factionId, clanId(owner))).orderBy(asc(alphaWeeks.weekStart)).limit(1);
    // A week is earned when it closes: its start plus seven days.
    return oneShot(w ? { at: new Date(w.weekStart.getTime() + WEEK), id: w.id, evidence: { rank: w.rank } } : undefined);
  },

  dynasty: async (db, owner) => {
    const target = T("dynasty");
    const weeks = await db.select({ id: alphaWeeks.id, weekStart: alphaWeeks.weekStart }).from(alphaWeeks)
      .where(eq(alphaWeeks.factionId, clanId(owner))).orderBy(asc(alphaWeeks.weekStart));
    let run = 0, best = 0, prev = Number.NEGATIVE_INFINITY;
    for (const w of weeks) {
      const t = w.weekStart.getTime();
      run = t - prev === WEEK ? run + 1 : 1;
      prev = t;
      if (run > best) best = run;
      if (run === target) return { count: run, target, earnedAt: new Date(t + WEEK), evidenceId: w.id, evidence: { weeks: run } };
    }
    return { count: best, target };
  },

  podium: async (db, owner) => {
    const s = (await closedSeasons(db, clanId(owner))).find((x) => x.rank <= 3);
    return oneShot(s ? { at: s.endedAt!, id: s.id, serverId: s.serverId, evidence: { rank: s.rank, season: s.number } } : undefined);
  },

  untouched: async (db, owner) => {
    // Never raided across a season the clan was active for ALL of: activated on or before the
    // season opened, and still holding at the close (the result row's status).
    const [f] = await db.select({ activatedAt: factions.activatedAt }).from(factions).where(eq(factions.id, clanId(owner)));
    const s = (await closedSeasons(db, clanId(owner))).find((x) =>
      x.timesRaided === 0 && f?.activatedAt && f.activatedAt.getTime() <= x.startedAt.getTime() && (HOLDING_STATUSES as readonly string[]).includes(x.statusAtClose));
    return oneShot(s ? { at: s.endedAt!, id: s.id, serverId: s.serverId, evidence: { season: s.number } } : undefined);
  },

  champions: async (db, owner) => {
    const [s] = await db.select({ id: seasons.id, at: seasons.endedAt, serverId: seasons.serverId, number: seasons.number }).from(seasons)
      .where(and(eq(seasons.championFactionId, clanId(owner)), isNotNull(seasons.endedAt))).orderBy(asc(seasons.endedAt)).limit(1);
    return oneShot(s ? { at: s.at!, id: s.id, serverId: s.serverId, evidence: { season: s.number } } : undefined);
  },

  // ── The members together (spec 2026-10-20-achievements-150, Task B8) ──────
  // ⚠️ Not kill-derived PLAYER tiles: a clan's unlock is not revocable (revoke.ts), and these
  // read `killer_faction_id`, which kills-tick freezes at the kill.

  clan_warband: async (db, owner, ctx) => nth(await clanPvpKills(db, ctx, clanId(owner)), T("clan_warband"), (r) => ({ kills: r.length })),

  /** Distinct firearms over the clan's scoring kills; earned at the kill that made the 25th. Unmapped names count for nothing. */
  clan_armory: async (db, owner, ctx) =>
    nth([...firstsByFirearm(await clanPvpKills(db, ctx, clanId(owner))).values()], T("clan_armory"), (r) => ({ firearms: r.length })),

  /** Ruin repairs (`base.built`, no structure) made while the repairer was a full member, on the clan's server. */
  clan_renovators: async (db, owner) => {
    const id = clanId(owner);
    const rows = await db.select({ id: events.id, at: events.occurredAt, serverId: events.serverId }).from(events)
      .where(and(eq(events.type, "base.built"), isRuinRepair, memberAt(id, sql`${events.payload}->>'dayzId'`, sql`${events.occurredAt}`, sql`${events.serverId}`)))
      .orderBy(asc(events.occurredAt), asc(events.id));
    return nth(rows, T("clan_renovators"), (r) => ({ repairs: r.length }));
  },

  /**
   * Per gun class, the earliest member unlock of its class tile earned INSIDE that member's span
   * in this clan (a tile brought in from before joining does not count); earned at the latest of
   * those firsts, the sixth class's. Unlock rows carry no server, so the span is not server-scoped.
   * The tick re-evaluates the clan when a class tile unlocks (touched.ts, `classUnlocks`).
   */
  clan_arsenal: async (db, owner) => {
    const target = T("clan_arsenal");
    const rows = await db.select({ key: achievementUnlocks.key, at: sql<Date>`min(${achievementUnlocks.earnedAt})`.mapWith(achievementUnlocks.earnedAt) })
      .from(achievementUnlocks)
      .where(and(eq(achievementUnlocks.ownerKind, "player"), inArray(achievementUnlocks.key, [...CLASS_TILE_KEYS]),
        memberAt(clanId(owner), sql`${achievementUnlocks.ownerId}`, sql`${achievementUnlocks.earnedAt}`)))
      .groupBy(achievementUnlocks.key);
    if (rows.length < target) return { count: rows.length, target };
    const at = new Date(Math.max(...rows.map((r) => r.at.getTime())));
    return { count: target, target, earnedAt: at, evidenceId: null, evidence: { classes: target } };
  },
};
