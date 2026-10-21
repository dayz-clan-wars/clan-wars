import { ACHIEVEMENT_BY_KEY, EMOTES, type AchievementKey, type EarnableKey } from "@factions/domain";
import { achievementCounters, ceremonyParticipants, events, factions, identityLinks, membershipHistory, playerSessions } from "@factions/db";
import { and, asc, eq, isNotNull, sql } from "drizzle-orm";
import { nth, oneShot, type Rule, type RuleCtx } from "./types.js";

const T = (k: AchievementKey) => ACHIEVEMENT_BY_KEY[k].target;
const HOUR = 3_600_000, DAY = 86_400_000;

/**
 * Sessions with a close, ascending, read once per owner per pass for the three hours rules.
 * Open sessions never count: their length is not known yet.
 */
const closedSessions = (db: Parameters<Rule>[0], ctx: RuleCtx, dayzId: string) =>
  ctx.memo(`sessions:closed:${dayzId}`, () =>
    db.select({ id: playerSessions.id, from: playerSessions.connectedAt, to: playerSessions.disconnectedAt, serverId: playerSessions.serverId })
      .from(playerSessions).where(and(eq(playerSessions.dayzId, dayzId), isNotNull(playerSessions.disconnectedAt)))
      .orderBy(asc(playerSessions.connectedAt), asc(playerSessions.id)));

/** Hours played; earned at the disconnect that carried the total over the target. */
const hoursPlayed = (key: AchievementKey): Rule => async (db, owner, ctx) => {
  const target = T(key);
  let ms = 0;
  for (const s of await closedSessions(db, ctx, owner.id)) {
    ms += s.to!.getTime() - s.from.getTime();
    if (ms >= target * HOUR) {
      return { count: Math.floor(ms / HOUR), target, earnedAt: s.to!, evidenceId: s.id, evidence: { hours: Math.floor(ms / HOUR) }, serverId: s.serverId };
    }
  }
  return { count: Math.floor(ms / HOUR), target };
};

/**
 * A lifetime counter (counters.ts keeps it); earned at the moment the counter recorded crossing.
 * `from` names another tile's counter row and `field` the detail key holding this tile's crossing:
 * Globetrotter reads Explorer's square set, whose crossing of 150 is `globetrotterAt`.
 * ⚠️ Never read the counter's `crossedAt` for a second target: it is when the set reached
 * Explorer's 50, and would date a Globetrotter unlock to the wrong fix.
 */
const counter = (key: AchievementKey, from: AchievementKey = key, field = "crossedAt"): Rule => async (db, owner) => {
  const target = T(key);
  const [c] = await db.select().from(achievementCounters)
    .where(and(eq(achievementCounters.ownerKind, owner.kind), eq(achievementCounters.ownerId, owner.id), eq(achievementCounters.key, from)));
  if (!c) return { count: 0, target };
  const raw = c.detail[field];
  const crossedAt = typeof raw === "string" ? new Date(raw) : undefined;
  return c.value >= target && crossedAt ? { count: c.value, target, earnedAt: crossedAt, evidence: { count: c.value } } : { count: c.value, target };
};

/** The owner's emotes in time order, each with its `payload.emote` token, read once per owner per pass for the five emote rules. */
const ownEmotes = (db: Parameters<Rule>[0], ctx: RuleCtx, dayzId: string) =>
  ctx.memo(`emotes:${dayzId}`, () =>
    db.select({ id: events.id, at: events.occurredAt, serverId: events.serverId, emote: sql<string | null>`${events.payload}->>'emote'` }).from(events)
      .where(and(eq(events.type, "emote.performed"), sql`${events.payload}->>'dayzId' = ${dayzId}`))
      .orderBy(asc(events.occurredAt), asc(events.id)));

/** Emotes of any kind, counted. */
const emoteCount = (key: AchievementKey): Rule => async (db, owner, ctx) => nth(await ownEmotes(db, ctx, owner.id), T(key));

/**
 * Distinct emote tokens, earned at the emote that brought the target-th new one. `among` limits
 * which tokens count: Full Repertoire counts only EMOTES, so a token outside the list (a PC-only
 * emote, a parser oddity) can never stand in for a missing console one.
 */
const distinctEmotes = (key: AchievementKey, among?: ReadonlySet<string>): Rule => async (db, owner, ctx) => {
  const target = T(key);
  const seen = new Set<string>();
  for (const e of await ownEmotes(db, ctx, owner.id)) {
    if (!e.emote || seen.has(e.emote) || (among && !among.has(e.emote))) continue;
    seen.add(e.emote);
    if (seen.size === target) return { count: target, target, earnedAt: e.at, evidenceId: e.id, evidence: { emotes: target }, serverId: e.serverId };
  }
  return { count: seen.size, target };
};
const EMOTE_SET: ReadonlySet<string> = new Set(EMOTES);

/**
 * The longest run of consecutive UTC dates with a session start; earned at the session that
 * made the run reach the target. Regular (7) and Devoted (30) share one read per owner per pass.
 */
const consecutiveDays = (key: AchievementKey): Rule => async (db, owner, ctx) => {
  const target = T(key);
  const sessions = await ctx.memo(`sessions:starts:${owner.id}`, () =>
    db.select({ id: playerSessions.id, at: playerSessions.connectedAt, serverId: playerSessions.serverId })
      .from(playerSessions).where(eq(playerSessions.dayzId, owner.id)).orderBy(asc(playerSessions.connectedAt)));
  let run = 0, best = 0, prevDay = Number.NEGATIVE_INFINITY;
  for (const s of sessions) {
    const day = Math.floor(s.at.getTime() / DAY);
    if (day === prevDay) continue;
    run = day === prevDay + 1 ? run + 1 : 1;
    prevDay = day;
    if (run > best) best = run;
    if (run === target) return { count: run, target, earnedAt: s.at, evidenceId: s.id, evidence: { days: run }, serverId: s.serverId };
  }
  return { count: best, target };
};

export const SOLO_RULES: Partial<Record<EarnableKey, Rule>> = {
  enlisted: async (db, owner) => {
    const [l] = await db.select({ id: identityLinks.id, at: identityLinks.verifiedAt }).from(identityLinks).where(eq(identityLinks.dayzId, owner.id));
    return oneShot(l ? { at: l.at, id: l.id } : undefined);
  },

  squad_up: async (db, owner) => {
    const [m] = await db.select({ id: membershipHistory.id, at: membershipHistory.joinedAt, serverId: membershipHistory.serverId, factionId: membershipHistory.factionId })
      .from(membershipHistory).where(eq(membershipHistory.dayzId, owner.id)).orderBy(asc(membershipHistory.joinedAt)).limit(1);
    return oneShot(m ? { at: m.at, id: m.id, serverId: m.serverId, evidence: { factionId: m.factionId } } : undefined);
  },

  founder: async (db, owner) => {
    // A participant of the ceremony a clan points at. Dated to the clan's activation (creation if
    // never activated) rather than to the `ceremony_participants` row on purpose: participants are
    // recorded WHILE the ceremony runs, before anyone knows whether it resolves, so a participant
    // row is not yet evidence of anything. The fact this achievement witnesses is the clan
    // existing, and the instant that became true is the activation. A ceremony that never produced
    // a clan has no row here at all (the join is through `factions.ceremony_id`).
    const [r] = await db.select({ id: factions.id, at: sql<Date>`coalesce(${factions.activatedAt}, ${factions.createdAt})`, serverId: factions.serverId, tag: factions.tag })
      .from(ceremonyParticipants).innerJoin(factions, eq(factions.ceremonyId, ceremonyParticipants.ceremonyId))
      .where(eq(ceremonyParticipants.dayzId, owner.id)).orderBy(asc(factions.createdAt)).limit(1);
    return oneShot(r ? { at: new Date(r.at), id: r.id, serverId: r.serverId, evidence: { tag: r.tag } } : undefined);
  },

  loyalist: async (db, owner, { now }) => {
    // Longest single span; an open span runs to `now` — the one place a rule reads the clock, and the
    // earned_at is still joinedAt + 30 d, so live and backfill agree.
    const target = T("loyalist");
    const spans = await db.select({ id: membershipHistory.id, from: membershipHistory.joinedAt, to: membershipHistory.leftAt, serverId: membershipHistory.serverId, factionId: membershipHistory.factionId })
      .from(membershipHistory).where(eq(membershipHistory.dayzId, owner.id)).orderBy(asc(membershipHistory.joinedAt));
    let best = 0;
    for (const s of spans) {
      const days = Math.floor(((s.to ?? now).getTime() - s.from.getTime()) / DAY);
      if (days > best) best = days;
      if (days >= target) return { count: days, target, earnedAt: new Date(s.from.getTime() + target * DAY), evidenceId: s.id, evidence: { days, factionId: s.factionId }, serverId: s.serverId };
    }
    return { count: best, target };
  },

  long_haul: hoursPlayed("long_haul"),
  veteran: hoursPlayed("veteran"),
  lifer: hoursPlayed("lifer"),

  regular: consecutiveDays("regular"),
  devoted: consecutiveDays("devoted"),

  showman: emoteCount("showman"),
  performer: emoteCount("performer"),
  mime: distinctEmotes("mime"),
  full_repertoire: distinctEmotes("full_repertoire", EMOTE_SET),
  rps_champ: async (db, owner, ctx) =>
    nth((await ownEmotes(db, ctx, owner.id)).filter((e) => e.emote === "EmoteRPSRandom"), T("rps_champ"), (r) => ({ games: r.length })),

  explorer: counter("explorer"),
  globetrotter: counter("globetrotter", "explorer", "globetrotterAt"),
  cartographer: counter("cartographer"),
};
