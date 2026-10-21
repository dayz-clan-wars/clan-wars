import { ACHIEVEMENT_BY_KEY, FIREARMS, createFirearmLookup, firearmOf, isFist, isKnife, isSledgehammer, meleeWeaponOf, motorbikeOfWeapon, streakOf, type AchievementKey, type EarnableKey, type FirearmClass, type FirearmKey } from "@factions/domain";
import { defenses, kills, playerSessions, raids } from "@factions/db";
import { and, asc, eq, ne, isNotNull, or, sql } from "drizzle-orm";
import { incidents, ownHits } from "./hits.js";
import { nth, oneShot, type Rule, type RuleCtx, type RuleResult } from "./types.js";

const T = (k: AchievementKey) => ACHIEVEMENT_BY_KEY[k].target;

/**
 * A scoring PvP kill, whoever made it: another player did it, it was not friendly fire (Global
 * Constraints), and it was not at the Hub (spec 2026-09-22-hub-combat).
 * ⚠️ The ONE statement of those conditions for the achievements: `pvpBy` (a player's kills) and
 * `pvpByClan` (the clan tiles) both add only "who gets the credit" to it, so the two can never drift.
 */
const scoringPvp = and(isNotNull(kills.killerDayzId), ne(kills.victimDayzId, kills.killerDayzId), eq(kills.friendlyFire, false), eq(kills.atHub, false));
const pvpBy = (dayzId: string) => and(eq(kills.killerDayzId, dayzId), scoringPvp);
/** The clan's scoring kills: credited by `killer_faction_id`, the killer's clan resolved at the kill (kills-tick's `membershipAt`). */
const pvpByClan = (factionId: number) => and(eq(kills.killerFactionId, factionId), scoringPvp);
const killCols = { id: kills.id, at: kills.occurredAt, serverId: kills.serverId, victim: kills.victimDayzId, weapon: kills.weapon, distanceM: kills.distanceM };
export type KillRow = { id: number; at: Date; serverId: number; victim: string; weapon: string | null; distanceM: string | null };

async function pvpKills(db: Parameters<Rule>[0], dayzId: string): Promise<KillRow[]> {
  return db.select(killCols).from(kills).where(pvpBy(dayzId)).orderBy(asc(kills.occurredAt), asc(kills.id));
}
/** The owner's scoring PvP kills, read once per owner per pass and shared between every rule that wants them. */
// ⚠️ The memo key carries the id: a ctx is per owner today, but a constant key would hand a
// second owner sharing one ctx the first owner's kills, silently.
export const ownPvpKills = (db: Parameters<Rule>[0], ctx: RuleCtx, dayzId: string): Promise<KillRow[]> =>
  ctx.memo(`pvpKills:${dayzId}`, () => pvpKills(db, dayzId));
/** The clan's scoring PvP kills in time order, shared by Warband and Armory in one pass. Memo key carries the id, as above. */
export const clanPvpKills = (db: Parameters<Rule>[0], ctx: RuleCtx, factionId: number): Promise<KillRow[]> =>
  ctx.memo(`clanPvpKills:${factionId}`, () => db.select(killCols).from(kills).where(pvpByClan(factionId)).orderBy(asc(kills.occurredAt), asc(kills.id)));
const killCount = (key: AchievementKey): Rule => async (db, owner, ctx) => nth(await ownPvpKills(db, ctx, owner.id), T(key), (r) => ({ kills: r.length }));

// ── The armory (spec 2026-10-20-achievements-150 §2.2, §2.3) ──────────────────

/**
 * ONE lookup for the process, so an unmapped display name is logged once, not once per
 * owner per pass (spec §2.2: an unknown name counts toward nothing and must be logged, or a
 * misspelled catalogue row silently makes a tile unearnable).
 */
const firearmLookup = createFirearmLookup((message) => console.warn(message));

/**
 * The firearm a scoring kill was made with, or null. A name the catalogue knows is credited
 * whatever else the row says. An unknown name is only reported when the kill is plausibly a
 * gun kill: it has a range (every gun kill line carries `from N meters`; melee lines never do,
 * spec §2.4) and is not a vehicle. ⚠️ Not `meleeWeaponOf` alone: it calls every unknown string
 * melee, so gating on it would mean an unmapped gun is never reported.
 */
function firearmOfKill(k: KillRow): FirearmKey | null {
  const known = firearmOf(k.weapon);
  if (known) return known;
  const w = k.weapon?.trim() ?? "";
  if (!w || k.distanceM === null || motorbikeOfWeapon(w) || w.startsWith("TransportHit")) return null;
  return firearmLookup(w);
}

/**
 * Each firearm's FIRST scoring kill (time order), shared by every gun, class and Full Armory
 * rule of one owner in one pass. Built from `ownPvpKills`, so `pvpBy` is the only filter.
 */
export const gunSet = (db: Parameters<Rule>[0], ctx: RuleCtx, dayzId: string): Promise<Map<FirearmKey, KillRow>> =>
  ctx.memo(`gunSet:${dayzId}`, async () => firstsByFirearm(await ownPvpKills(db, ctx, dayzId)));

/**
 * Each firearm's first kill among `rows` (already in time order), in the order the firearms
 * were first used — so the n-th entry is the kill that made n. Shared with the clan's Armory,
 * so an unmapped name is judged (and logged, once per process) the same way for both.
 */
export function firstsByFirearm(rows: readonly KillRow[]): Map<FirearmKey, KillRow> {
  const firsts = new Map<FirearmKey, KillRow>();
  for (const k of rows) {
    const f = firearmOfKill(k);
    if (f && !firsts.has(f)) firsts.set(f, k);
  }
  return firsts;
}

const gun = (key: FirearmKey): Rule => async (db, owner, ctx) => {
  const k = (await gunSet(db, ctx, owner.id)).get(key);
  return oneShot(k ? { at: k.at, id: k.id, serverId: k.serverId, evidence: { weapon: k.weapon } } : undefined);
};

/**
 * A set of firearms: progress is how many have a kill; earned at the kill that completed the
 * set, the latest of the set's first kills (id breaks a same-second tie, as the kill order does).
 */
const gunsOf = (key: AchievementKey, members: readonly FirearmKey[]): Rule => async (db, owner, ctx) => {
  const target = T(key);
  const set = await gunSet(db, ctx, owner.id);
  const firsts = members.flatMap((f) => set.get(f) ?? []);
  if (firsts.length < target) return { count: firsts.length, target };
  const last = firsts.reduce((a, b) => (b.at.getTime() > a.at.getTime() || (b.at.getTime() === a.at.getTime() && b.id > a.id) ? b : a));
  return { count: target, target, earnedAt: last.at, evidenceId: last.id, evidence: { firearms: target }, serverId: last.serverId };
};
const ofClass = (c: FirearmClass): FirearmKey[] => FIREARMS.filter((f) => f.class === c).map((f) => f.key);

const ARMORY_RULES = {
  ...Object.fromEntries(FIREARMS.map((f) => [`gun_${f.key}`, gun(f.key)])),
  class_pistols: gunsOf("class_pistols", ofClass("pistol")),
  class_smgs: gunsOf("class_smgs", ofClass("smg")),
  class_shotguns: gunsOf("class_shotguns", ofClass("shotgun")),
  class_assault_rifles: gunsOf("class_assault_rifles", ofClass("assault_rifle")),
  class_rifles: gunsOf("class_rifles", ofClass("rifle")),
  class_snipers: gunsOf("class_snipers", ofClass("sniper")),
  full_armory: gunsOf("full_armory", FIREARMS.map((f) => f.key)),
} as Partial<Record<EarnableKey, Rule>>;

// ── Up close: melee and motorbikes (spec 2026-10-20-achievements-150 §2.4, §2.6) ──

/**
 * The owner's scoring kills that are melee kills, in time order, each with its stable melee name.
 * ⚠️ `distanceM === null` is half the test, not a nicety: `meleeWeaponOf` calls every string it
 * does not know a melee weapon, so an unmapped gun would count toward Hands On without it. Every
 * gun kill line carries `from N meters`; no melee line does (spec §2.4).
 */
async function meleeKills(db: Parameters<Rule>[0], ctx: RuleCtx, dayzId: string) {
  return (await ownPvpKills(db, ctx, dayzId)).flatMap((k) => {
    const melee = k.distanceM === null ? meleeWeaponOf(k.weapon) : null;
    return melee ? [{ ...k, melee }] : [];
  });
}
const meleeWith = (test: (w: string | null) => boolean): Rule => async (db, owner, ctx) => {
  const k = (await meleeKills(db, ctx, owner.id)).find((m) => test(m.weapon));
  return oneShot(k ? { at: k.at, id: k.id, serverId: k.serverId, evidence: { weapon: k.weapon } } : undefined);
};

const MELEE_RULES: Partial<Record<EarnableKey, Rule>> = {
  knife_work: meleeWith(isKnife),
  bare_knuckles: meleeWith(isFist),
  sledge: meleeWith(isSledgehammer),

  // Distinct by the stable name, so the three fist spellings are one weapon, not three.
  melee_mix: async (db, owner, ctx) => {
    const target = T("melee_mix");
    const seen = new Set<string>();
    for (const k of await meleeKills(db, ctx, owner.id)) {
      if (seen.has(k.melee)) continue;
      seen.add(k.melee);
      if (seen.size === target) return { count: target, target, earnedAt: k.at, evidenceId: k.id, evidence: { weapons: [...seen].join(", ") }, serverId: k.serverId };
    }
    return { count: seen.size, target };
  },

  roadkill: async (db, owner, ctx) => {
    const k = (await ownPvpKills(db, ctx, owner.id)).find((r) => motorbikeOfWeapon(r.weapon));
    return oneShot(k ? { at: k.at, id: k.id, serverId: k.serverId, evidence: { vehicle: motorbikeOfWeapon(k.weapon) } } : undefined);
  },

  /**
   * Hitting another player with a motorbike you are riding. Reads hits, not kills, so it is not
   * revocable (revoke.ts) and `pvpBy` does not apply: no kill was scored. One per incident, a
   * distinct (victim, second), because a bike logs a burst of identical lines (spec §2.6).
   */
  hit_and_run: async (db, owner, ctx) => {
    const hits = (await ownHits(db, ctx, owner.id, "attacker")).filter((h) => h.victimDayzId !== owner.id && motorbikeOfWeapon(h.weapon));
    return nth(incidents(hits), T("hit_and_run"), (r) => ({ incidents: r.length }));
  },
};

/**
 * Longer-range rules (marksman, sniper): the target is a distance in metres, so the
 * count IS that distance — best-so-far as progress, floored, never from a null distance.
 */
const distance = (key: AchievementKey): Rule => async (db, owner, ctx) => {
  const target = T(key);
  let best = 0;
  for (const k of await ownPvpKills(db, ctx, owner.id)) {
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
const pointBlank = (key: AchievementKey): Rule => async (db, owner, ctx) => {
  const threshold = T(key);
  const hit = (await ownPvpKills(db, ctx, owner.id)).find((k) => k.distanceM !== null && Number(k.distanceM) < threshold);
  return oneShot(hit ? { at: hit.at, id: hit.id, serverId: hit.serverId, evidence: { distanceM: Math.floor(Number(hit.distanceM)), weapon: hit.weapon } } : undefined);
};

function streak(key: AchievementKey): Rule {
  return async (db, owner): Promise<RuleResult> => {
    const target = T(key);
    // Every kill row the player is on either side of, ascending — the walk needs deaths too.
    const rows = await db.select({ id: kills.id, killer: kills.killerDayzId, victim: kills.victimDayzId, friendlyFire: kills.friendlyFire, atHub: kills.atHub, occurredAt: kills.occurredAt, serverId: kills.serverId })
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

export const PVP_RULES: Partial<Record<EarnableKey, Rule>> = {
  ...ARMORY_RULES,
  ...MELEE_RULES,
  first_blood: killCount("first_blood"),
  ten_down: killCount("ten_down"),
  centurion: killCount("centurion"),
  warlord: killCount("warlord"),
  marksman: distance("marksman"),
  sniper: distance("sniper"),
  long_shot: distance("long_shot"),
  point_blank: pointBlank("point_blank"),

  arsenal: async (db, owner, ctx) => {
    const target = T("arsenal");
    const seen = new Set<string>();
    for (const k of await ownPvpKills(db, ctx, owner.id)) {
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

  // ⚠️ `evidence.victim` is a raw dayz id, and it must NEVER be rendered. `evidence` is stored
  // for forensics only — `notice-text.ts` and the web tiles read `key`/`name`/`description` and
  // nothing else — so naming the victim here is private. Posting "Ann earned Nemesis (5 kills on
  // Ben)" hands out a grudge list the game never surfaces; the same applies to `blue_on_blue`
  // below, where the victim is a clanmate. If a renderer ever wants evidence, these two keys
  // must be excluded or the id resolved away first.
  nemesis: async (db, owner, ctx) => {
    const target = T("nemesis");
    const per = new Map<string, number>();
    let best = 0;
    for (const k of await ownPvpKills(db, ctx, owner.id)) {
      const n = (per.get(k.victim) ?? 0) + 1;
      per.set(k.victim, n);
      if (n > best) best = n;
      if (n === target) return { count: n, target, earnedAt: k.at, evidenceId: k.id, evidence: { victim: k.victim, kills: n }, serverId: k.serverId };
    }
    return { count: best, target };
  },

  // Distinct victims among scoring kills; earned at the kill of the target-th new one.
  // ⚠️ Evidence is the count only, never the ids: the list of who someone killed is the grudge
  // list the note on nemesis above warns about, times twenty-five.
  headhunter: async (db, owner, ctx) => {
    const target = T("headhunter");
    const seen = new Set<string>();
    for (const k of await ownPvpKills(db, ctx, owner.id)) {
      if (seen.has(k.victim)) continue;
      seen.add(k.victim);
      if (seen.size === target) return { count: target, target, earnedAt: k.at, evidenceId: k.id, evidence: { victims: target }, serverId: k.serverId };
    }
    return { count: seen.size, target };
  },

  payback: async (db, owner) => {
    // My kill of V at t, where V killed me at t′ with 0 < t − t′ ≤ 1 h. One SQL self-join, earliest first.
    const k2 = sql`k2`;
    const rows = await db.execute(sql`
      select k.id, k.occurred_at as at, k.server_id, k.victim_dayz_id as victim
      from kills k
      where k.killer_dayz_id = ${owner.id} and k.victim_dayz_id <> ${owner.id} and k.friendly_fire = false and k.at_hub = false
        and exists (
          select 1 from kills ${k2}
          where ${k2}.killer_dayz_id = k.victim_dayz_id and ${k2}.victim_dayz_id = ${owner.id} and ${k2}.at_hub = false
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

  // ⚠️ `evidence.victim` is an unrendered dayz id — see the note on `nemesis` above. Naming the
  // clanmate someone team-killed in a public post is the worst version of that leak.
  // A record, not a score: a Hub teamkill still counts here (spec 2026-09-22-hub-combat §4.3).
  blue_on_blue: async (db, owner) => {
    const [k] = await db.select(killCols).from(kills).where(and(eq(kills.killerDayzId, owner.id), eq(kills.friendlyFire, true)))
      .orderBy(asc(kills.occurredAt), asc(kills.id)).limit(1);
    return oneShot(k ? { at: k.at, id: k.id, serverId: k.serverId, evidence: { victim: k.victim } } : undefined);
  },
};
