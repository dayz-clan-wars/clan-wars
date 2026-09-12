import {
  servers, admFiles, events, kills, playerSessions, identityLinks, membershipHistory, raids, defenses, alphaWeeks, seasonResults,
  type Database,
} from "@factions/db";
export { seedFaction, seedSeason } from "../seed.js";

const admFileFor = new Map<number, number>();

export async function seedServer(db: Database) {
  const [s] = await db.insert(servers).values({ name: "S", map: "livonia", clockOffsetMs: 0 }).returning();
  admFileFor.clear();
  return s!;
}
async function admFile(db: Database, serverId: number, at: Date): Promise<number> {
  let id = admFileFor.get(serverId);
  if (!id) {
    const [f] = await db.insert(admFiles).values({ serverId, filename: `f${serverId}.ADM`, bootAt: at, linesIngested: 0, complete: true }).returning();
    id = f!.id; admFileFor.set(serverId, id);
  }
  return id;
}
let line = 0;

export async function seedEvent(db: Database, a: { serverId: number; type: string; at: Date; payload: Record<string, unknown> }) {
  const [e] = await db.insert(events).values({
    serverId: a.serverId, admFileId: await admFile(db, a.serverId, a.at), lineIndex: line++, type: a.type as never, occurredAt: a.at, payload: a.payload,
  }).returning();
  return e!;
}
export async function seedLink(db: Database, a: { dayzId: string; discordId: string; gamertag: string; verifiedAt: Date }) {
  const [l] = await db.insert(identityLinks).values(a).returning();
  return l!;
}
export async function seedKill(db: Database, a: {
  serverId: number; killer: string | null; victim: string; at: Date; weapon?: string | null; distanceM?: number | null;
  cause?: string; friendlyFire?: boolean; killerFactionId?: number | null; victimFactionId?: number | null;
}) {
  const ev = await seedEvent(db, { serverId: a.serverId, type: a.killer ? "player.killed" : "player.died", at: a.at, payload: {} });
  const [k] = await db.insert(kills).values({
    serverId: a.serverId, eventId: ev.id, occurredAt: a.at, victimDayzId: a.victim, killerDayzId: a.killer,
    weapon: a.weapon ?? (a.killer ? "M4-A1" : null), distanceM: a.distanceM == null ? null : String(a.distanceM),
    cause: a.cause ?? (a.killer ? "pvp" : "died"), friendlyFire: a.friendlyFire ?? false,
    killerFactionId: a.killerFactionId ?? null, victimFactionId: a.victimFactionId ?? null,
  }).returning();
  return k!;
}
export async function seedSession(db: Database, a: { serverId: number; dayzId: string; from: Date; to: Date | null; closeReason?: "disconnect" | "restart" }) {
  const ev = await seedEvent(db, { serverId: a.serverId, type: "player.connected", at: a.from, payload: { dayzId: a.dayzId } });
  const [s] = await db.insert(playerSessions).values({
    serverId: a.serverId, dayzId: a.dayzId, connectedAt: a.from, connectEventId: ev.id,
    disconnectedAt: a.to, closeReason: a.to ? (a.closeReason ?? "disconnect") : null,
  }).returning();
  return s!;
}
export async function seedMembership(db: Database, a: { serverId: number; factionId: number; dayzId: string; joinedAt: Date; leftAt?: Date | null }) {
  const [m] = await db.insert(membershipHistory).values({ ...a, leftAt: a.leftAt ?? null }).returning();
  return m!;
}
export async function seedRaid(db: Database, a: {
  serverId: number; seasonId: number; victimFactionId: number; raiderDayzId: string; raiderFactionId: number | null; at: Date;
  victimRank?: number | null; rankedCount?: number; points?: number;
}) {
  const ev = await seedEvent(db, { serverId: a.serverId, type: "flag.lowered", at: a.at, payload: {} });
  const week = new Date(a.at); week.setUTCHours(0, 0, 0, 0); week.setUTCDate(week.getUTCDate() - ((week.getUTCDay() + 6) % 7));
  const [r] = await db.insert(raids).values({
    serverId: a.serverId, seasonId: a.seasonId, victimFactionId: a.victimFactionId, raiderDayzId: a.raiderDayzId, raiderFactionId: a.raiderFactionId,
    firstLowerEventId: ev.id, firstLowerAt: a.at, lastLowerEventId: ev.id, lastLowerAt: a.at, lowerCount: 1,
    points: a.points ?? 100, victimRankAtLower: a.victimRank ?? null, rankedCountAtLower: a.rankedCount ?? 0, weekStart: week,
  }).returning();
  return r!;
}
export async function seedDefense(db: Database, a: { serverId: number; factionId: number; seasonId: number; raisedByDayzId: string; at: Date; siegeSeconds: number }) {
  const ev = await seedEvent(db, { serverId: a.serverId, type: "flag.raised", at: a.at, payload: {} });
  const [d] = await db.insert(defenses).values({
    factionId: a.factionId, seasonId: a.seasonId, raisedByDayzId: a.raisedByDayzId, eventId: ev.id,
    flagDownSince: new Date(a.at.getTime() - a.siegeSeconds * 1000), defendedAt: a.at, siegeSeconds: a.siegeSeconds,
  }).returning();
  return d!;
}
export async function seedAlphaWeek(db: Database, a: { seasonId: number; factionId: number; weekStart: Date; rank: number; points?: number }) {
  const [w] = await db.insert(alphaWeeks).values({ ...a, points: a.points ?? 100 }).returning();
  return w!;
}
export async function seedSeasonResult(db: Database, a: { seasonId: number; factionId: number; rank: number; timesRaided: number; statusAtClose?: string; raids?: number; defenses?: number; points?: number }) {
  const [r] = await db.insert(seasonResults).values({
    seasonId: a.seasonId, factionId: a.factionId, rank: a.rank, points: a.points ?? 0, raids: a.raids ?? 0,
    timesRaided: a.timesRaided, defenses: a.defenses ?? 0, statusAtClose: a.statusAtClose ?? "active",
  }).returning();
  return r!;
}

/** The truncate list every achievements test uses. */
export const TRUNCATE = `truncate table achievement_unlocks, achievement_progress, achievement_counters, clan_notices, war_log_events,
  kills, player_sessions, player_positions, clan_pins, defenses, raids, alpha_weeks, season_results, season_standings, seasons,
  membership_history, ceremony_participants, ceremonies, faction_members, declarations, poles, factions, identity_links, players,
  consumer_cursors, events, adm_files, servers restart identity cascade`;
