import type { Database } from "@factions/db";
import {
  alphaWeeks, declarations, defenses, factions, players, raids, seasonResults, seasonStandings, seasons,
} from "@factions/db";
import { alias } from "drizzle-orm/pg-core";
import { and, asc, desc, eq, inArray, isNull, isNotNull, sql, or } from "drizzle-orm";
import { weekStartOf } from "@factions/domain";
import { activeServerId } from "./server";

const DAY_MS = 86_400_000;
const WEEK_MS = 7 * DAY_MS;

export type ScoreboardRow = {
  rank: number | null; tag: string; name: string; texture: string; status: string;
  points: number; raids: number; timesRaided: number; defenses: number; alpha: boolean;
};
export type Scoreboard = { season: { number: number; startedAt: Date; weekClosedThrough: Date | null } | null; rows: ScoreboardRow[] };

export type AlphaWeek = { weekStart: Date; entries: { rank: number; tag: string; name: string; texture: string; points: number }[] };

export type SeasonSummary = {
  number: number; startedAt: Date; endedAt: Date;
  champion: { tag: string; name: string; texture: string; points: number } | null;
  rows: { rank: number; tag: string; name: string; texture: string; points: number; raids: number; timesRaided: number; defenses: number; statusAtClose: string }[];
};

export type WarLogEntry =
  | { kind: "raid"; at: Date; raider: { tag: string; name: string } | null; victim: { tag: string; name: string; texture: string }; gamertag: string | null; points: number; lowers: number }
  | { kind: "defense"; at: Date; victim: { tag: string; name: string; texture: string }; gamertag: string | null; durationSeconds: number };

/** The open season on this server (`seasons_open_uniq`), or null before season 1 opens. Package-local twin of apps/bot/src/season.ts's `openSeason` — not importable from here. */
async function openSeasonFor(db: Database, serverId: number) {
  const [s] = await db.select({
    id: seasons.id, number: seasons.number, startedAt: seasons.startedAt, weekClosedThrough: seasons.weekClosedThrough,
  }).from(seasons).where(and(eq(seasons.serverId, serverId), isNull(seasons.endedAt)));
  return s ?? null;
}

/** Which clans hold an Alpha badge right now: the open season's latest closed week's top three. Empty before any week has closed. */
export async function latestAlphaFactionIds(db: Database, serverId: number): Promise<Set<number>> {
  const season = await openSeasonFor(db, serverId);
  if (!season || !season.weekClosedThrough) return new Set();
  const rows = await db.select({ factionId: alphaWeeks.factionId }).from(alphaWeeks)
    .where(and(eq(alphaWeeks.seasonId, season.id), eq(alphaWeeks.weekStart, season.weekClosedThrough)));
  return new Set(rows.map((r) => r.factionId));
}

/**
 * The open season's table in §8.1 order: ranked clans (rank 1..N) first,
 * then unranked (rank null) by name. Disbanded/lapsed clans are excluded.
 *
 * The §8.1 order (points desc, times_raided asc, activated_at asc, then
 * `factions.id` asc as the final deterministic tie-break) is
 * re-implemented here as one SQL `order by` — the bot's `standings.ts` is
 * not importable from this package. apps/bot/test/standings.test.ts's
 * "rankedStandings orders by points desc, times_raided asc, activated_at
 * asc..." test is this function's twin: `scoring.test.ts`'s "scoreboard
 * order" test pins the identical `[A, C, B]` fixture.
 */
export async function scoreboardDb(db: Database): Promise<Scoreboard> {
  const serverId = await activeServerId(db);
  const season = await openSeasonFor(db, serverId);
  if (!season) return { season: null, rows: [] };

  const points = sql<number>`coalesce(${seasonStandings.points}, 0)`;
  const timesRaided = sql<number>`coalesce(${seasonStandings.timesRaided}, 0)`;
  const rows = await db.select({
    factionId: factions.id, tag: factions.tag, name: factions.name, texture: factions.texture, status: factions.status,
    activatedAt: factions.activatedAt,
    points: points.mapWith(Number),
    raids: sql<number>`coalesce(${seasonStandings.raids}, 0)`.mapWith(Number),
    timesRaided: timesRaided.mapWith(Number),
    defenses: sql<number>`coalesce(${seasonStandings.defenses}, 0)`.mapWith(Number),
  }).from(factions)
    .leftJoin(seasonStandings, and(eq(seasonStandings.factionId, factions.id), eq(seasonStandings.seasonId, season.id)))
    .where(and(eq(factions.serverId, serverId), inArray(factions.status, ["active", "dormant"])))
    .orderBy(desc(points), asc(timesRaided), asc(factions.activatedAt), asc(factions.id));

  const ranked = rows.filter((r) => r.status === "active" && r.points > 0);
  const rankOf = new Map(ranked.map((r, i) => [r.factionId, i + 1]));
  const unranked = rows.filter((r) => !rankOf.has(r.factionId))
    .sort((a, b) => a.name.toLowerCase().localeCompare(b.name.toLowerCase()));

  const alphaIds = await latestAlphaFactionIds(db, serverId);
  const toRow = (r: (typeof rows)[number]): ScoreboardRow => ({
    rank: rankOf.get(r.factionId) ?? null, tag: r.tag, name: r.name, texture: r.texture, status: r.status,
    points: r.points, raids: r.raids, timesRaided: r.timesRaided, defenses: r.defenses, alpha: alphaIds.has(r.factionId),
  });

  return {
    season: { number: season.number, startedAt: season.startedAt, weekClosedThrough: season.weekClosedThrough },
    rows: [...ranked.map(toRow), ...unranked.map(toRow)],
  };
}

/** Every closed week of the open season, newest first; a week nobody scored has no entries. */
export async function alphasDb(db: Database): Promise<{ season: { number: number } | null; weeks: AlphaWeek[] }> {
  const serverId = await activeServerId(db);
  const season = await openSeasonFor(db, serverId);
  if (!season) return { season: null, weeks: [] };
  if (!season.weekClosedThrough) return { season: { number: season.number }, weeks: [] };

  const weekStarts: Date[] = [];
  for (let w = weekStartOf(season.startedAt); w.getTime() <= season.weekClosedThrough.getTime(); w = new Date(w.getTime() + WEEK_MS)) {
    weekStarts.push(w);
  }

  const rows = await db.select({
    weekStart: alphaWeeks.weekStart, rank: alphaWeeks.rank, tag: factions.tag, name: factions.name, texture: factions.texture, points: alphaWeeks.points,
  }).from(alphaWeeks)
    .innerJoin(factions, eq(factions.id, alphaWeeks.factionId))
    .where(eq(alphaWeeks.seasonId, season.id))
    .orderBy(asc(alphaWeeks.rank));

  const byWeek = new Map<number, typeof rows>();
  for (const r of rows) {
    const key = r.weekStart.getTime();
    const bucket = byWeek.get(key);
    if (bucket) bucket.push(r); else byWeek.set(key, [r]);
  }

  const weeks = weekStarts.map((weekStart) => ({
    weekStart,
    entries: (byWeek.get(weekStart.getTime()) ?? []).map((r) => ({ rank: r.rank, tag: r.tag, name: r.name, texture: r.texture, points: r.points })),
  })).reverse();

  return { season: { number: season.number }, weeks };
}

/** Closed seasons, newest first, from season_results. */
export async function seasonsDb(db: Database): Promise<SeasonSummary[]> {
  const serverId = await activeServerId(db);
  const closed = await db.select({ id: seasons.id, number: seasons.number, startedAt: seasons.startedAt, endedAt: seasons.endedAt })
    .from(seasons)
    .where(and(eq(seasons.serverId, serverId), isNotNull(seasons.endedAt)))
    .orderBy(desc(seasons.number));
  if (closed.length === 0) return [];

  const results = await db.select({
    seasonId: seasonResults.seasonId, rank: seasonResults.rank, points: seasonResults.points, raids: seasonResults.raids,
    timesRaided: seasonResults.timesRaided, defenses: seasonResults.defenses, statusAtClose: seasonResults.statusAtClose,
    tag: factions.tag, name: factions.name, texture: factions.texture,
  }).from(seasonResults)
    .innerJoin(factions, eq(factions.id, seasonResults.factionId))
    .where(inArray(seasonResults.seasonId, closed.map((s) => s.id)))
    .orderBy(asc(seasonResults.rank));

  const bySeason = new Map<number, typeof results>();
  for (const r of results) {
    const bucket = bySeason.get(r.seasonId);
    if (bucket) bucket.push(r); else bySeason.set(r.seasonId, [r]);
  }

  return closed.map((s) => {
    const rows = bySeason.get(s.id) ?? [];
    const top = rows.find((r) => r.rank === 1);
    const champion = top && top.points > 0 ? { tag: top.tag, name: top.name, texture: top.texture, points: top.points } : null;
    return {
      number: s.number, startedAt: s.startedAt, endedAt: s.endedAt!,
      champion,
      rows: rows.map((r) => ({
        rank: r.rank, tag: r.tag, name: r.name, texture: r.texture, points: r.points,
        raids: r.raids, timesRaided: r.timesRaided, defenses: r.defenses, statusAtClose: r.statusAtClose,
      })),
    };
  });
}

/** Raids and defenses of the open season, newest first, from raids + defenses (never from the queue). */
/** A war log filter: one clan (as raider or victim), one kind, or both. Filtered in SQL so the limit counts matching rows. */
export type WarLogFilter = { clanTag?: string; kind?: "raid" | "defense" };

export async function warLogDb(db: Database, limit = 100, filter: WarLogFilter = {}): Promise<WarLogEntry[]> {
  const serverId = await activeServerId(db);
  const season = await openSeasonFor(db, serverId);
  if (!season) return [];
  const tag = filter.clanTag?.toUpperCase();

  const raiderFactions = alias(factions, "raider_factions");
  const raidRows = filter.kind === "defense" ? [] : await db.select({
    at: raids.firstLowerAt, points: raids.points, lowers: raids.lowerCount,
    victimTag: factions.tag, victimName: factions.name, victimTexture: factions.texture,
    raiderTag: raiderFactions.tag, raiderName: raiderFactions.name,
    gamertag: players.gamertag,
  }).from(raids)
    .innerJoin(factions, eq(factions.id, raids.victimFactionId))
    .leftJoin(raiderFactions, eq(raiderFactions.id, raids.raiderFactionId))
    .leftJoin(players, eq(players.dayzId, raids.raiderDayzId))
    .where(tag ? and(eq(raids.seasonId, season.id), or(eq(factions.tag, tag), eq(raiderFactions.tag, tag))) : eq(raids.seasonId, season.id))
    .orderBy(desc(raids.firstLowerAt))
    .limit(limit);

  const defenseRows = filter.kind === "raid" ? [] : await db.select({
    at: defenses.defendedAt, durationSeconds: defenses.siegeSeconds,
    victimTag: factions.tag, victimName: factions.name, victimTexture: factions.texture,
    gamertag: players.gamertag,
  }).from(defenses)
    .innerJoin(factions, eq(factions.id, defenses.factionId))
    .leftJoin(players, eq(players.dayzId, defenses.raisedByDayzId))
    .where(tag ? and(eq(defenses.seasonId, season.id), eq(factions.tag, tag)) : eq(defenses.seasonId, season.id))
    .orderBy(desc(defenses.defendedAt))
    .limit(limit);

  const merged: WarLogEntry[] = [
    ...raidRows.map((r): WarLogEntry => ({
      kind: "raid", at: r.at,
      raider: r.raiderTag ? { tag: r.raiderTag, name: r.raiderName! } : null,
      victim: { tag: r.victimTag, name: r.victimName, texture: r.victimTexture },
      gamertag: r.gamertag ?? null, points: r.points, lowers: r.lowers,
    })),
    ...defenseRows.map((r): WarLogEntry => ({
      kind: "defense", at: r.at,
      victim: { tag: r.victimTag, name: r.victimName, texture: r.victimTexture },
      gamertag: r.gamertag ?? null, durationSeconds: r.durationSeconds,
    })),
  ];
  merged.sort((a, b) => b.at.getTime() - a.at.getTime());
  return merged.slice(0, limit);
}

/** `ClanPage.placements`: this clan's finishes across closed seasons, newest first. */
export async function placementsFor(db: Database, factionId: number): Promise<{ season: number; rank: number; points: number }[]> {
  const rows = await db.select({ number: seasons.number, rank: seasonResults.rank, points: seasonResults.points })
    .from(seasonResults)
    .innerJoin(seasons, eq(seasons.id, seasonResults.seasonId))
    .where(eq(seasonResults.factionId, factionId))
    .orderBy(desc(seasons.number));
  return rows.map((r) => ({ season: r.number, rank: r.rank, points: r.points }));
}

/** `ClanPage.alphaWeeks`: how many weeks, across every season, this clan has taken an Alpha rank. */
export async function alphaWeekCountFor(db: Database, factionId: number): Promise<number> {
  const [row] = await db.select({ n: sql<number>`count(*)::int` }).from(alphaWeeks).where(eq(alphaWeeks.factionId, factionId));
  return row?.n ?? 0;
}

/** `ClanPage.stats`: the open season's raids/defenses, the longest siege this clan has ever survived, and days held at the current declaration. */
export async function clanStatsFor(db: Database, factionId: number, now: Date): Promise<{ raids: number; defenses: number; longestSiegeSeconds: number | null; daysHeld: number | null }> {
  const serverId = await activeServerId(db);
  const season = await openSeasonFor(db, serverId);
  let raidCount = 0;
  let defenseCount = 0;
  if (season) {
    const [standing] = await db.select({ raids: seasonStandings.raids, defenses: seasonStandings.defenses })
      .from(seasonStandings)
      .where(and(eq(seasonStandings.seasonId, season.id), eq(seasonStandings.factionId, factionId)));
    raidCount = standing?.raids ?? 0;
    defenseCount = standing?.defenses ?? 0;
  }

  const [siege] = await db.select({ max: sql<number | null>`max(${defenses.siegeSeconds})` }).from(defenses).where(eq(defenses.factionId, factionId));
  const longestSiegeSeconds = siege?.max ?? null;

  const [decl] = await db.select({ declaredAt: declarations.declaredAt }).from(declarations).where(eq(declarations.ownerFactionId, factionId));
  const daysHeld = decl ? Math.floor((now.getTime() - decl.declaredAt.getTime()) / DAY_MS) : null;

  return { raids: raidCount, defenses: defenseCount, longestSiegeSeconds, daysHeld };
}
