import {
  ACHIEVEMENT_BY_KEY, BAD_DOG_SURVIVE_MS, GRENADE_ENTITY_RE, HOT_FOOD_RE, MINE_ENTITIES, RUIN_KIND, TENTS, isDogLabel, isMotorbikeClass,
  type AchievementKey, type EarnableKey, type RuinKind,
} from "@factions/domain";
import { events, kills, playerSessions } from "@factions/db";
import { isBaseBuild, isRuinRepair } from "@factions/roster/internal";
import { and, asc, eq, inArray, isNull, isNotNull, sql } from "drizzle-orm";
import { incidents, ownHits, type HitRow } from "./hits.js";
import { nth, oneShot, type Hit, type Rule } from "./types.js";

const T = (k: AchievementKey) => ACHIEVEMENT_BY_KEY[k].target;
const HOUR = 3_600_000;

// Duplicated from rules-solo.ts on purpose: the plan keeps each group file self-contained.
async function ownEvents(db: Parameters<Rule>[0], type: string, dayzId: string, extra = sql`true`) {
  return db.select({ id: events.id, at: events.occurredAt, serverId: events.serverId }).from(events)
    .where(and(eq(events.type, type as never), sql`${events.payload}->>'dayzId' = ${dayzId}`, extra))
    .orderBy(asc(events.occurredAt), asc(events.id));
}
/** Build points (`base.built` with a structure; ruin repairs never count), read once per owner per pass for the four build rules. */
const built = (key: AchievementKey): Rule => async (db, owner, ctx) =>
  nth(await ctx.memo(`builds:${owner.id}`, () => ownEvents(db, "base.built", owner.id, isBaseBuild)), T(key), (rows) => ({ buildPoints: rows.length }));

/** Every death of the owner, any cause, killer or not, read once per owner per pass: Nine Lives and Hundred Lives. */
const deaths = (key: AchievementKey): Rule => async (db, owner, ctx) => {
  const rows = await ctx.memo(`deaths:${owner.id}`, () =>
    db.select({ id: kills.id, at: kills.occurredAt, serverId: kills.serverId }).from(kills)
      .where(eq(kills.victimDayzId, owner.id)).orderBy(asc(kills.occurredAt), asc(kills.id)));
  return nth(rows, T(key), (r) => ({ deaths: r.length }));
};

/**
 * A death to the environment with the named cause; killer is null for every non-player death.
 *
 * `killer_dayz_id IS NULL` is the definition of the family, not an oversight — including
 * `sunday_driver`, where a player who runs someone over is a credited PvP kill and counts as
 * one everywhere else (spec §11, `killer_dayz_id` is the whole test). Dropping the predicate
 * for "vehicle" would award an environment achievement for being murdered by a person.
 */
const deathBy = (cause: string): Rule => async (db, owner) => {
  const [k] = await db.select({ id: kills.id, at: kills.occurredAt, serverId: kills.serverId }).from(kills)
    .where(and(eq(kills.victimDayzId, owner.id), isNull(kills.killerDayzId), eq(kills.cause, cause)))
    .orderBy(asc(kills.occurredAt), asc(kills.id)).limit(1);
  return oneShot(k ? { at: k.at, id: k.id, serverId: k.serverId, evidence: { cause } } : undefined);
};

/**
 * The owner's deaths with no killer, each with its death EVENT's `entity` (what the log says killed
 * them: `Motorbike_02_Yellow`, `LandMineTrap`, `M67Grenade`), in time order. The entity is not on
 * the kill row, so it is read through `kills.event_id`.
 *
 * ⚠️ `killer_dayz_id IS NULL` as in deathBy: a death a player is credited with is theirs, never
 * the bike's, the mine's or the grenade's.
 */
const noKillerDeaths = async (db: Parameters<Rule>[0], dayzId: string, cause?: string) =>
  db.select({ id: kills.id, at: kills.occurredAt, serverId: kills.serverId, cause: kills.cause, entity: sql<string | null>`${events.payload}->>'entity'` })
    .from(kills).innerJoin(events, eq(events.id, kills.eventId))
    .where(and(eq(kills.victimDayzId, dayzId), isNull(kills.killerDayzId), cause === undefined ? undefined : eq(kills.cause, cause)))
    .orderBy(asc(kills.occurredAt), asc(kills.id));

/** Ruin repairs: every `base.built` line with no structure is one (spec §2.7), memoised for the four ruin rules. */
const ruinRepairs = (db: Parameters<Rule>[0], ctx: Parameters<Rule>[2], dayzId: string) =>
  ctx.memo(`ruins:${dayzId}`, async () => {
    const rows = await db.select({ id: events.id, at: events.occurredAt, serverId: events.serverId, part: sql<string | null>`${events.payload}->>'part'` }).from(events)
      .where(and(eq(events.type, "base.built"), sql`${events.payload}->>'dayzId' = ${dayzId}`, isRuinRepair))
      .orderBy(asc(events.occurredAt), asc(events.id));
    return rows.map((r) => ({ id: r.id, at: r.at, serverId: r.serverId, kind: r.part ? RUIN_KIND(r.part) : null }));
  });

/** A trap or wire hit the owner took: the first one matching. */
const hitBy = (match: (h: HitRow) => boolean, evidence: (h: HitRow) => Hit["evidence"]): Rule =>
  async (db, owner, ctx) => {
    const h = (await ownHits(db, ctx, owner.id, "victim")).find((r) => r.attackerType !== "player" && match(r));
    return oneShot(h ? { at: h.at, id: h.id, serverId: h.serverId, evidence: evidence(h) } : undefined);
  };

/** Items the owner placed (`item.placed`) or packed (`item.packed`), by display name. */
const ownItems = (db: Parameters<Rule>[0], type: "item.placed" | "item.packed", dayzId: string, items: readonly string[]) =>
  ownEvents(db, type, dayzId, inArray(sql<string>`${events.payload}->>'item'`, [...items]));
const items = (key: AchievementKey, type: "item.placed" | "item.packed", names: readonly string[]): Rule =>
  async (db, owner) => nth(await ownItems(db, type, owner.id, names), T(key), (r) => ({ count: r.length }));

const MINE_SET = new Set<string>(MINE_ENTITIES);
const FIXER_KINDS: readonly RuinKind[] = ["door", "window", "roof"];

/** Dog bites the owner took, every line (Chew Toy counts lines, not attacks: spec §2.5). */
const dogBites = async (db: Parameters<Rule>[0], ctx: Parameters<Rule>[2], dayzId: string) =>
  (await ownHits(db, ctx, dayzId, "victim")).filter((h) => isDogLabel(h.attackerLabel));

export const PVE_RULES: Partial<Record<EarnableKey, Rule>> = {
  foundation: built("foundation"),
  builder: built("builder"),
  architect: built("architect"),
  master_builder: built("master_builder"),

  // wolf_bait and bear_necessities are retired (no wolves or bears on Nasdara): no rule, so
  // nothing unlocks them again, and their holders' rows are never touched.
  brains: deathBy("infected"),
  gravity_check: deathBy("fall"),
  sunday_driver: deathBy("vehicle"),
  should_have_bandaged: deathBy("bled_out"),
  sleeps_with_fishes: deathBy("drowned"),

  // ── Dogs and motorbikes (spec 2026-10-20-achievements-150 §2.5, §2.6) ──────
  // ⚠️ deathBy's `killer_dayz_id IS NULL` is what keeps a player's kill after dog bites (or a
  // driver running you down) from counting: that death is the player's, not the dog's or bike's.
  dog_food: deathBy("dog"),

  chew_toy: async (db, owner, ctx) => nth(await dogBites(db, ctx, owner.id), T("chew_toy"), (r) => ({ bites: r.length })),

  /**
   * The first bite followed by BAD_DOG_SURVIVE_MS with no death of the owner, earned at the end
   * of that window, not at the bite: until then nobody knows they survived it.
   * ⚠️ Earned only once `ctx.now` has reached the window's end. Earning it earlier on "no death
   * yet" would hand it to someone the dog is still chewing, and an unlock is never revoked.
   */
  bad_dog: async (db, owner, ctx) => {
    const bites = await dogBites(db, ctx, owner.id);
    if (!bites.length) return { count: 0, target: 1 };
    const deaths = (await db.select({ at: kills.occurredAt }).from(kills).where(eq(kills.victimDayzId, owner.id))).map((d) => d.at.getTime());
    for (const b of bites) {
      const from = b.at.getTime(), until = from + BAD_DOG_SURVIVE_MS;
      if (until > ctx.now.getTime()) break;   // bites are in time order: every later window ends later still
      // ⚠️ `>=`, not the brief's open `(bite, …]`: the log has one-second resolution, and a death
      // in the bite's own second is that bite killing you, not an earlier life.
      if (deaths.some((d) => d >= from && d <= until)) continue;
      return oneShot({ at: new Date(until), id: b.id, serverId: b.serverId, evidence: { dog: b.attackerLabel } });
    }
    return { count: 0, target: 1 };
  },

  // A no-driver motorbike hit: the bike is the attacker label and no player is. One per burst.
  road_rash: async (db, owner, ctx) => {
    const hits = (await ownHits(db, ctx, owner.id, "victim")).filter((h) => h.attackerType !== "player" && isMotorbikeClass(h.attackerLabel));
    return nth(incidents(hits), T("road_rash"), (r) => ({ incidents: r.length }));
  },

  wipeout: async (db, owner) => {
    // The bike's class is on the death EVENT (`killed by NO DRIVER (Motorbike_02_Yellow)` → entity),
    // not on the kill row, whose cause is the plain "vehicle" every car death also gets.
    // Filtered here, not in SQL, so `isMotorbikeClass` stays the one statement of "a motorbike".
    const k = (await noKillerDeaths(db, owner.id, "vehicle")).find((r) => isMotorbikeClass(r.entity));
    return oneShot(k ? { at: k.at, id: k.id, serverId: k.serverId, evidence: { vehicle: k.entity } } : undefined);
  },

  // ── Ruins (spec 2026-10-20-achievements-150 §2.7) ─────────────────────────
  // ⚠️ `isRuinRepair`, the complement of the build-point rule's `isBaseBuild`: a Fence build is
  // never a ruin repair, and a ruin repair is never a build point.
  squatter: async (db, owner, ctx) => nth(await ruinRepairs(db, ctx, owner.id), T("squatter"), (r) => ({ repairs: r.length })),
  renovator: async (db, owner, ctx) => nth(await ruinRepairs(db, ctx, owner.id), T("renovator"), (r) => ({ repairs: r.length })),
  rubble_rouser: async (db, owner, ctx) =>
    nth((await ruinRepairs(db, ctx, owner.id)).filter((r) => r.kind === "rubble"), T("rubble_rouser"), (r) => ({ rubble: r.length })),

  /** Earned at the repair that completes {door, window, roof}, on any buildings: the log names no building. */
  fixer_upper: async (db, owner, ctx) => {
    const seen = new Set<RuinKind>();
    for (const r of await ruinRepairs(db, ctx, owner.id)) {
      if (!r.kind || !FIXER_KINDS.includes(r.kind)) continue;
      seen.add(r.kind);
      if (seen.size === FIXER_KINDS.length) return oneShot({ at: r.at, id: r.id, serverId: r.serverId, evidence: { parts: FIXER_KINDS.join(",") } });
    }
    return { count: 0, target: 1 };
  },

  // ── Traps and explosives (§2.8) ────────────────────────────────────────────
  snapped: hitBy((h) => h.attackerLabel === "BearTrap", (h) => ({ trap: h.attackerLabel })),
  tripped: hitBy((h) => h.attackerLabel === "TripwireTrap", (h) => ({ trap: h.attackerLabel })),
  // The wire is the mechanism, not the label: barbed wire hangs on a Fence, Watchtower or Gate.
  snagged: hitBy((h) => h.cause === "BarbedWireHit", (h) => ({ on: h.attackerLabel })),

  minesweeper: async (db, owner) => {
    // ⚠️ Read the entity, never the cause: `killed by LandMineTrap` is filed "environment" (the
    // parser's `mine\b` cannot match inside "MineTrap"), only a Claymore is filed "explosion".
    const k = (await noKillerDeaths(db, owner.id)).find((r) => r.entity != null && MINE_SET.has(r.entity));
    return oneShot(k ? { at: k.at, id: k.id, serverId: k.serverId, evidence: { entity: k.entity } } : undefined);
  },

  frag_out: async (db, owner) => {
    // A grenade's entity is its display name cut at the first hyphen or space ("6", "RGD") or its
    // classname ("M67Grenade"); GRENADE_ENTITY_RE is the one statement of that. An M79 death prints
    // `killed by  with 40mm Explosive Grenade` and stores no entity, the thrower lost: it counts too.
    // ⚠️ The null-entity arm needs cause "explosion": every bare `died.` also stores a null entity.
    const k = (await noKillerDeaths(db, owner.id)).find((r) =>
      r.entity != null ? GRENADE_ENTITY_RE.test(r.entity) : r.cause === "explosion");
    return oneShot(k ? { at: k.at, id: k.id, serverId: k.serverId, evidence: { entity: k.entity } } : undefined);
  },

  // ── Oddities (§2.10) ───────────────────────────────────────────────────────
  burned: hitBy((h) => h.attackerLabel === "Fireplace", (h) => ({ fire: h.attackerLabel })),
  // Eating food still too hot: `hit by HumanSteakMeat with EnviroDmg`. ⚠️ The cause is half the
  // test: HOT_FOOD_RE alone also matches a SteakKnife, and hitBy already drops player hits.
  hipster: hitBy((h) => h.cause === "EnviroDmg" && h.attackerLabel != null && HOT_FOOD_RE.test(h.attackerLabel), (h) => ({ food: h.attackerLabel })),

  // ── Camp (§2.9) ────────────────────────────────────────────────────────────
  barrel_hoarder: items("barrel_hoarder", "item.placed", ["Barrel"]),
  pack_up: items("pack_up", "item.packed", TENTS),
  sea_legs: items("sea_legs", "item.placed", ["Sea Chest"]),
  minefield: items("minefield", "item.placed", ["Land Mine"]),

  lights_out: async (db, owner) =>
    nth(await ownEvents(db, "player.unconscious", owner.id, sql`coalesce((${events.payload}->>'disconnecting')::boolean, false) = false`), T("lights_out")),

  // Coming round after a knockout (`player.conscious`): every line is one, as every knockout is one for Lights Out.
  comeback: async (db, owner) => nth(await ownEvents(db, "player.conscious", owner.id), T("comeback")),

  nine_lives: deaths("nine_lives"),
  hundred_lives: deaths("hundred_lives"),

  ironman: async (db, owner) => {
    // Walk closed sessions in order; a death inside a session splits it, and only time after the
    // last death counts toward the run. Earned at the instant the run reaches the target.
    const target = T("ironman");
    const sessions = await db.select({ id: playerSessions.id, from: playerSessions.connectedAt, to: playerSessions.disconnectedAt, serverId: playerSessions.serverId })
      .from(playerSessions).where(and(eq(playerSessions.dayzId, owner.id), isNotNull(playerSessions.disconnectedAt)))
      .orderBy(asc(playerSessions.connectedAt), asc(playerSessions.id));
    const deaths = (await db.select({ at: kills.occurredAt }).from(kills).where(eq(kills.victimDayzId, owner.id)).orderBy(asc(kills.occurredAt))).map((d) => d.at.getTime());
    let di = 0, run = 0, best = 0;
    for (const s of sessions) {
      let from = s.from.getTime();
      const to = s.to!.getTime();
      // ⚠️ `run = 0` here too: a death in the GAP between two sessions (logged out, died on
      // reconnect-and-crash, killed by a log-out timer) still breaks the streak. Skipping it
      // without zeroing silently welds the two sessions together and grants ironman to a
      // player who died between them — the one case no test would notice, since both
      // sessions look clean on their own.
      while (di < deaths.length && deaths[di]! < from) { run = 0; di++; }
      while (di < deaths.length && deaths[di]! <= to) { run = 0; from = deaths[di]!; di++; }
      if (run + (to - from) >= target * HOUR) {
        const at = new Date(from + target * HOUR - run);
        return { count: target, target, earnedAt: at, evidenceId: s.id, evidence: { hours: target }, serverId: s.serverId };
      }
      run += to - from;
      if (run > best) best = run;
    }
    return { count: Math.floor(best / HOUR), target };
  },
};
