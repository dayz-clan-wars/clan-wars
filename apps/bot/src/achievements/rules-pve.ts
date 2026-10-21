import { ACHIEVEMENT_BY_KEY, BAD_DOG_SURVIVE_MS, isDogLabel, isMotorbikeClass, type AchievementKey, type EarnableKey } from "@factions/domain";
import { events, kills, playerSessions } from "@factions/db";
import { isBaseBuild } from "@factions/roster/internal";
import { and, asc, eq, isNull, isNotNull, sql } from "drizzle-orm";
import { incidents, ownHits } from "./hits.js";
import { nth, oneShot, type Rule } from "./types.js";

const T = (k: AchievementKey) => ACHIEVEMENT_BY_KEY[k].target;
const HOUR = 3_600_000;

// Duplicated from rules-solo.ts on purpose: the plan keeps each group file self-contained.
async function ownEvents(db: Parameters<Rule>[0], type: string, dayzId: string, extra = sql`true`) {
  return db.select({ id: events.id, at: events.occurredAt, serverId: events.serverId }).from(events)
    .where(and(eq(events.type, type as never), sql`${events.payload}->>'dayzId' = ${dayzId}`, extra))
    .orderBy(asc(events.occurredAt), asc(events.id));
}
const built = (key: AchievementKey): Rule => async (db, owner) => nth(await ownEvents(db, "base.built", owner.id, isBaseBuild), T(key), (rows) => ({ buildPoints: rows.length }));

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

/** Dog bites the owner took, every line (Chew Toy counts lines, not attacks: spec §2.5). */
const dogBites = async (db: Parameters<Rule>[0], ctx: Parameters<Rule>[2], dayzId: string) =>
  (await ownHits(db, ctx, dayzId, "victim")).filter((h) => isDogLabel(h.attackerLabel));

export const PVE_RULES: Partial<Record<EarnableKey, Rule>> = {
  foundation: built("foundation"),
  builder: built("builder"),
  architect: built("architect"),

  // wolf_bait and bear_necessities are retired (no wolves or bears on Nasdara): no rule, so
  // nothing unlocks them again, and their holders' rows are never touched.
  brains: deathBy("infected"),
  gravity_check: deathBy("fall"),
  sunday_driver: deathBy("vehicle"),
  should_have_bandaged: deathBy("bled_out"),

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
    const rows = await db.select({ id: kills.id, at: kills.occurredAt, serverId: kills.serverId, entity: sql<string | null>`${events.payload}->>'entity'` })
      .from(kills).innerJoin(events, eq(events.id, kills.eventId))
      .where(and(eq(kills.victimDayzId, owner.id), isNull(kills.killerDayzId), eq(kills.cause, "vehicle")))
      .orderBy(asc(kills.occurredAt), asc(kills.id));
    const k = rows.find((r) => isMotorbikeClass(r.entity));
    return oneShot(k ? { at: k.at, id: k.id, serverId: k.serverId, evidence: { vehicle: k.entity } } : undefined);
  },

  lights_out: async (db, owner) =>
    nth(await ownEvents(db, "player.unconscious", owner.id, sql`coalesce((${events.payload}->>'disconnecting')::boolean, false) = false`), T("lights_out")),

  nine_lives: async (db, owner) => {
    const rows = await db.select({ id: kills.id, at: kills.occurredAt, serverId: kills.serverId }).from(kills)
      .where(eq(kills.victimDayzId, owner.id)).orderBy(asc(kills.occurredAt), asc(kills.id));
    return nth(rows, T("nine_lives"), (r) => ({ deaths: r.length }));
  },

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
