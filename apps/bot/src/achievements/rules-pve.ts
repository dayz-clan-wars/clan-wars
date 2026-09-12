import { ACHIEVEMENT_BY_KEY, type AchievementKey } from "@factions/domain";
import { events, kills, playerSessions } from "@factions/db";
import { and, asc, eq, isNull, isNotNull, sql } from "drizzle-orm";
import { nth, oneShot, type Rule } from "./types.js";

const T = (k: AchievementKey) => ACHIEVEMENT_BY_KEY[k].target;
const HOUR = 3_600_000;

// Duplicated from rules-solo.ts on purpose: the plan keeps each group file self-contained.
async function ownEvents(db: Parameters<Rule>[0], type: string, dayzId: string, extra = sql`true`) {
  return db.select({ id: events.id, at: events.occurredAt, serverId: events.serverId }).from(events)
    .where(and(eq(events.type, type as never), sql`${events.payload}->>'dayzId' = ${dayzId}`, extra))
    .orderBy(asc(events.occurredAt), asc(events.id));
}
const built = (key: AchievementKey): Rule => async (db, owner) => nth(await ownEvents(db, "base.built", owner.id), T(key), (rows) => ({ buildPoints: rows.length }));

/** A death to the environment with the named cause; killer is null for every non-player death. */
const deathBy = (cause: string): Rule => async (db, owner) => {
  const [k] = await db.select({ id: kills.id, at: kills.occurredAt, serverId: kills.serverId }).from(kills)
    .where(and(eq(kills.victimDayzId, owner.id), isNull(kills.killerDayzId), eq(kills.cause, cause)))
    .orderBy(asc(kills.occurredAt), asc(kills.id)).limit(1);
  return oneShot(k ? { at: k.at, id: k.id, serverId: k.serverId, evidence: { cause } } : undefined);
};

export const PVE_RULES: Partial<Record<AchievementKey, Rule>> = {
  foundation: built("foundation"),
  builder: built("builder"),
  architect: built("architect"),

  wolf_bait: deathBy("wolf"),
  bear_necessities: deathBy("bear"),
  brains: deathBy("infected"),
  gravity_check: deathBy("fall"),
  sunday_driver: deathBy("vehicle"),
  should_have_bandaged: deathBy("bled_out"),

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
      while (di < deaths.length && deaths[di]! < from) di++;
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
