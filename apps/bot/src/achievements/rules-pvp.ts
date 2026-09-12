import { ACHIEVEMENT_BY_KEY, streakOf, type AchievementKey } from "@factions/domain";
import { defenses, kills, playerSessions, raids } from "@factions/db";
import { and, asc, eq, ne, isNotNull, or, sql } from "drizzle-orm";
import { nth, oneShot, type Rule, type RuleResult } from "./types.js";

const T = (k: AchievementKey) => ACHIEVEMENT_BY_KEY[k].target;

/** A PvP kill: another player did it, and it was not friendly fire (Global Constraints). */
const pvpBy = (dayzId: string) => and(eq(kills.killerDayzId, dayzId), ne(kills.victimDayzId, dayzId), eq(kills.friendlyFire, false));
const killCols = { id: kills.id, at: kills.occurredAt, serverId: kills.serverId, victim: kills.victimDayzId, weapon: kills.weapon, distanceM: kills.distanceM };
type KillRow = { id: number; at: Date; serverId: number; victim: string; weapon: string | null; distanceM: string | null };

async function pvpKills(db: Parameters<Rule>[0], dayzId: string): Promise<KillRow[]> {
  return db.select(killCols).from(kills).where(pvpBy(dayzId)).orderBy(asc(kills.occurredAt), asc(kills.id));
}
const killCount = (key: AchievementKey): Rule => async (db, owner) => nth(await pvpKills(db, owner.id), T(key), (r) => ({ kills: r.length }));

/**
 * Longer-range rules (marksman, sniper): the target is a distance in metres, so the
 * count IS that distance — best-so-far as progress, floored, never from a null distance.
 */
const distance = (key: AchievementKey): Rule => async (db, owner) => {
  const target = T(key);
  let best = 0;
  for (const k of await pvpKills(db, owner.id)) {
    if (k.distanceM === null) continue;
    const d = Number(k.distanceM);
    if (d > best) best = d;
    if (d >= target) return { count: Math.floor(d), target, earnedAt: k.at, evidenceId: k.id, evidence: { distanceM: Math.floor(d), weapon: k.weapon }, serverId: k.serverId };
  }
  return { count: Math.floor(best), target };
};

/**
 * point_blank is the opposite shape: the qualifying distance (under 5 m) is a threshold,
 * not a magnitude to report as progress — "how close are you to point blank" has no
 * meaningful units, so (unlike marksman/sniper) this is a plain one-shot: 0 until the
 * first sub-threshold kill, 1 once earned. The distance still rides along in evidence.
 * ⚠️ This deliberately reports `target: 1`, not the definition's real target of 5 (m):
 * a "less than" rule has no monotone progress to climb (getting further away raises the
 * distance without getting closer to earning it), so there is nothing sensible to hold
 * `count` below except the binary 0/1 of "not earned yet" / "earned" — and the tick
 * unlocks on `count >= target`, so `target` has to be 1 for that to ever fire. The site's
 * copy suppresses a progress line for this key rather than rendering "0 / 5" against a
 * count that can never mean "0 of 5 metres."
 */
const pointBlank = (key: AchievementKey): Rule => async (db, owner) => {
  const threshold = T(key);
  const hit = (await pvpKills(db, owner.id)).find((k) => k.distanceM !== null && Number(k.distanceM) < threshold);
  return oneShot(hit ? { at: hit.at, id: hit.id, serverId: hit.serverId, evidence: { distanceM: Math.floor(Number(hit.distanceM)), weapon: hit.weapon } } : undefined);
};

function streak(key: AchievementKey): Rule {
  return async (db, owner): Promise<RuleResult> => {
    const target = T(key);
    // Every kill row the player is on either side of, ascending — the walk needs deaths too.
    const rows = await db.select({ id: kills.id, killer: kills.killerDayzId, victim: kills.victimDayzId, friendlyFire: kills.friendlyFire, occurredAt: kills.occurredAt, serverId: kills.serverId })
      .from(kills).where(and(or(eq(kills.killerDayzId, owner.id), eq(kills.victimDayzId, owner.id)), isNotNull(kills.killerDayzId)))
      .orderBy(asc(kills.occurredAt), asc(kills.id));
    const s = streakOf(rows, owner.id);
    const at = s.reachedAt(target);
    const idx = s.reachedIndex(target);
    if (at === null || idx === null) return { count: s.best, target };
    // Index into `rows`, not a re-find by `occurredAt` — two of the owner's own kills can
    // share one timestamp (same-second log resolution), and `find` would silently grab
    // whichever one comes first rather than the one that actually crossed the target.
    const crossing = rows[idx]!;
    return { count: s.best, target, earnedAt: at, evidenceId: crossing.id, evidence: { streak: target }, serverId: crossing.serverId };
  };
}

export const PVP_RULES: Partial<Record<AchievementKey, Rule>> = {
  first_blood: killCount("first_blood"),
  ten_down: killCount("ten_down"),
  centurion: killCount("centurion"),
  marksman: distance("marksman"),
  sniper: distance("sniper"),
  point_blank: pointBlank("point_blank"),

  arsenal: async (db, owner) => {
    const target = T("arsenal");
    const seen = new Set<string>();
    for (const k of await pvpKills(db, owner.id)) {
      if (!k.weapon || seen.has(k.weapon)) continue;
      seen.add(k.weapon);
      if (seen.size === target) return { count: target, target, earnedAt: k.at, evidenceId: k.id, evidence: { weapons: [...seen].join(", ") }, serverId: k.serverId };
    }
    return { count: seen.size, target };
  },

  hat_trick: async (db, owner) => {
    // Each PvP kill joined to the killer's session that contains it; the third kill in any one session earns it.
    const target = T("hat_trick");
    const rows = await db.select({ id: kills.id, at: kills.occurredAt, serverId: kills.serverId, session: playerSessions.id })
      .from(kills).innerJoin(playerSessions, and(
        eq(playerSessions.dayzId, kills.killerDayzId),
        sql`${playerSessions.connectedAt} <= ${kills.occurredAt}`,
        sql`(${playerSessions.disconnectedAt} is null or ${kills.occurredAt} < ${playerSessions.disconnectedAt})`,
      ))
      .where(pvpBy(owner.id)).orderBy(asc(kills.occurredAt), asc(kills.id));
    const per = new Map<number, number>();
    let best = 0;
    for (const r of rows) {
      const n = (per.get(r.session) ?? 0) + 1;
      per.set(r.session, n);
      if (n > best) best = n;
      if (n === target) return { count: n, target, earnedAt: r.at, evidenceId: r.id, evidence: { kills: n }, serverId: r.serverId };
    }
    return { count: best, target };
  },

  killing_spree: streak("killing_spree"),
  unstoppable: streak("unstoppable"),

  nemesis: async (db, owner) => {
    const target = T("nemesis");
    const per = new Map<string, number>();
    let best = 0;
    for (const k of await pvpKills(db, owner.id)) {
      const n = (per.get(k.victim) ?? 0) + 1;
      per.set(k.victim, n);
      if (n > best) best = n;
      if (n === target) return { count: n, target, earnedAt: k.at, evidenceId: k.id, evidence: { victim: k.victim, kills: n }, serverId: k.serverId };
    }
    return { count: best, target };
  },

  payback: async (db, owner) => {
    // My kill of V at t, where V killed me at t′ with 0 < t − t′ ≤ 1 h. One SQL self-join, earliest first.
    const k2 = sql`k2`;
    const rows = await db.execute(sql`
      select k.id, k.occurred_at as at, k.server_id, k.victim_dayz_id as victim
      from kills k
      where k.killer_dayz_id = ${owner.id} and k.victim_dayz_id <> ${owner.id} and k.friendly_fire = false
        and exists (
          select 1 from kills ${k2}
          where ${k2}.killer_dayz_id = k.victim_dayz_id and ${k2}.victim_dayz_id = ${owner.id}
            and ${k2}.occurred_at < k.occurred_at and k.occurred_at - ${k2}.occurred_at <= interval '1 hour'
        )
      order by k.occurred_at, k.id limit 1`);
    // postgres.js via drizzle's db.execute returns an array-like of rows, not a { rows } wrapper.
    const [row] = rows as unknown as { id: number; at: Date; server_id: number; victim: string }[];
    return oneShot(row ? { at: new Date(row.at), id: Number(row.id), serverId: Number(row.server_id), evidence: { victim: row.victim } } : undefined);
  },

  flag_thief: async (db, owner) => {
    const [r] = await db.select({ id: raids.id, at: raids.firstLowerAt, serverId: raids.serverId, victim: raids.victimFactionId })
      .from(raids).where(eq(raids.raiderDayzId, owner.id)).orderBy(asc(raids.firstLowerAt)).limit(1);
    return oneShot(r ? { at: r.at, id: r.id, serverId: r.serverId, evidence: { victimFactionId: r.victim } } : undefined);
  },

  home_defender: async (db, owner) => {
    const [d] = await db.select({ id: defenses.id, at: defenses.defendedAt, siege: defenses.siegeSeconds, factionId: defenses.factionId })
      .from(defenses).where(eq(defenses.raisedByDayzId, owner.id)).orderBy(asc(defenses.defendedAt)).limit(1);
    return oneShot(d ? { at: d.at, id: d.id, evidence: { siegeSeconds: d.siege, factionId: d.factionId } } : undefined);
  },

  blue_on_blue: async (db, owner) => {
    const [k] = await db.select(killCols).from(kills).where(and(eq(kills.killerDayzId, owner.id), eq(kills.friendlyFire, true)))
      .orderBy(asc(kills.occurredAt), asc(kills.id)).limit(1);
    return oneShot(k ? { at: k.at, id: k.id, serverId: k.serverId, evidence: { victim: k.victim } } : undefined);
  },
};
