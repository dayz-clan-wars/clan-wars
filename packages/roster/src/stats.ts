import type { Database } from "@factions/db";
import {
  events, factionMembers, factions, identityLinks, kills, membershipHistory, playerSessions, players, raids, seasons,
} from "@factions/db";
import { KD_MIN_KILLS } from "@factions/domain";
import { and, asc, desc, eq, inArray, isNotNull, sql, type SQL } from "drizzle-orm";
import type { PgColumn, PgTable } from "drizzle-orm/pg-core";
import { activeServerId } from "./server";
import { actorFor, isRefusal, type ActorRefusal } from "./actor";

/**
 * Player stats (spec §11): the public boards, one player's profile, and the
 * same boards narrowed to a clan's own roster. Stats only — nothing here
 * writes, and nothing here reads or touches `season_standings`.
 *
 * ⚠️ "PvP" means "by another player". A self-kill (`killer_dayz_id =
 * victim_dayz_id` — a player's own grenade, say) is NEITHER a PvP kill nor a
 * PvP death: it is excluded from `pvpKills`, `pvpDeaths`, the killers board,
 * both K/D numerator and denominator, and the `killed`/`killedBy` lists. The
 * kills consumer already refuses to call one friendly fire for the same
 * reason. A death with no killer at all (infected, fall, bled out) is
 * likewise not a PvP death; it is simply not counted anywhere.
 *
 * ⚠️ "Last seen" is `players.last_seen_at` — the newest sighting the LOG has
 * of this character, in event time — not the newest row in
 * `player_sessions`. The log sees a player in ways that open no session.
 *
 * Every aggregate is bounded by the same season window, and every query that
 * `clanBoard` narrows carries the roster predicate in its WHERE clause, never
 * as a filter applied to wider rows afterwards.
 */

/**
 * What a caller asks for. `"current"` is the site's default when `?season=` is
 * absent or unparseable: it means "the newest season on the active server, or
 * all-time when there are no seasons". It is resolved HERE, not by the caller
 * — a page that resolved it itself would have to fetch a whole board set
 * purely to learn the season list first.
 */
export type StatScope = { kind: "all" } | { kind: "season"; number: number } | { kind: "current" };
/** What a scope resolved to. `Boards.scope` and `PlayerProfile.scope` are always one of these — never `"current"`. */
export type ResolvedScope = { kind: "all" } | { kind: "season"; number: number };
export type BoardRow = { dayzId: string; gamertag: string; value: number };
export type KdRow = BoardRow & { kills: number; deaths: number };
/** `value` is the distance in metres; `weapon` is what the log named for that kill. */
export type LongestKillRow = BoardRow & { weapon: string | null };
/** A player's current clan, for the flag beside their name. */
export type RowClan = { tag: string; texture: string };
/** Current full clan per player id, for every row on a board. A clanless or unlinked player has no entry. */
export type RowClans = Record<string, RowClan>;

export type Boards = {
  /** The clan behind each row's `dayzId`, across all nine boards. */
  clans: RowClans;
  /** ⚠️ The RESOLVED scope: a `"current"` request comes back as the season (or all-time) it named. */
  scope: ResolvedScope;
  /** The numbers available for the picker, newest first. */
  seasons: number[];
  raiders: BoardRow[];
  killers: BoardRow[];
  /** Most PvP deaths: killed by another player. A self-kill or a killer-less death is not one. */
  deaths: BoardRow[];
  kd: KdRow[];
  playTime: BoardRow[];
  friendlyFire: BoardRow[];
  /**
   * Build points: one per build step the log records (`base.built` — a kit
   * placed, a frame half, a panel half, a gate, a watchtower level), at any
   * pole, by the builder. Flat on purpose: a weight per part would be our
   * judgment layered on the log, and a finished fence is not something the
   * log can tell from five steps. Dismantles subtract nothing.
   */
  builders: BoardRow[];
  /**
   * Best killstreak: the most PvP kills in a row without a PvP death, inside
   * the window. Friendly fire neither extends a streak nor breaks it; a death
   * to anything but another player (infected, a fall, bleeding out) breaks
   * nothing — only being killed does, the same rule as the deaths board.
   */
  streaks: BoardRow[];
  /** Longest kill: each player's single farthest PvP kill, with its weapon. Friendly fire is not one. */
  longestKills: LongestKillRow[];
};
/**
 * The nine board names, in display order: raiding first, then offensive PvP
 * (kills, K/D, streak, range), building, play time, and last the two
 * shameful boards (deaths, friendly fire). The URL segment of a full-board
 * page is one of these.
 */
export const BOARD_KINDS = ["raiders", "killers", "kd", "streaks", "longestKills", "builders", "playTime", "deaths", "friendlyFire"] as const;
export type BoardKind = (typeof BOARD_KINDS)[number];
/** Rows per page on a full-board page. */
export const BOARD_PAGE_SIZE = 50;
/** One page of one board. `rows` is typed by kind at the edge: `kd` rows are `KdRow`, `longestKills` rows `LongestKillRow`. */
export type BoardPage = {
  scope: ResolvedScope;
  clans: RowClans;
  seasons: number[];
  kind: BoardKind;
  page: number;
  perPage: number;
  rows: BoardRow[] | KdRow[] | LongestKillRow[];
  hasNext: boolean;
};

export type PlayerProfile = {
  dayzId: string; gamertag: string; linked: boolean; scope: ResolvedScope; seasons: number[];
  playTimeSeconds: number; sessions: number; lastSeenAt: Date | null;
  pvpKills: number; pvpDeaths: number; kd: number | null;
  killedBy: { gamertag: string; count: number }[]; killed: { gamertag: string; count: number }[];
  friendlyFireKills: number; friendlyFireDeaths: number;
  raidCredits: number; upkeepRaises: number;
  /** The builders board's rule: `base.built` events by this player in the window. */
  buildPoints: number;
  /** The streaks board's rule, for this player. */
  bestStreak: number;
  /** The longest-kill board's rule, for this player; null with no PvP kill in the window. */
  longestKill: { distanceM: number; weapon: string | null } | null;
  clanHistory: { tag: string; name: string; joinedAt: Date; leftAt: Date | null }[];
  /** The current full clan, for the page's hero: tag, name and flag texture. Null for the clanless (a pending member included). */
  clan: { tag: string; name: string; texture: string } | null;
  /** Every PvP kill in the window this player was in, either side, newest first — the expandable rows under Killed / Killed by. */
  encounters: Encounter[];
};

/** One PvP kill between this player and another, either way round. Names, not ids: the page links them. */
export type Encounter = {
  at: Date; killer: string; victim: string; weapon: string | null; distanceM: number | null; friendlyFire: boolean;
};

/**
 * One line of a player's feed: what the log recorded about them, in time.
 * `death.other` is null for a death with no other player (infected, a fall,
 * their own grenade), and `cause` then says what the log called it. Build
 * steps and dismantles are grouped by the hour they fell in, `steps` each.
 */
export type FeedEntry =
  /** `cause` is `finished` for a credited kill (the victim was shot to near-zero and left to die), else the log's word. */
  | { kind: "kill"; at: Date; other: string; weapon: string | null; distanceM: number | null; friendlyFire: boolean; cause: string | null }
  | { kind: "death"; at: Date; other: string | null; weapon: string | null; distanceM: number | null; friendlyFire: boolean; cause: string | null }
  | { kind: "raid"; at: Date; victim: { tag: string; name: string } }
  | { kind: "raised"; at: Date }
  | { kind: "built"; at: Date; steps: number }
  | { kind: "dismantled"; at: Date; steps: number };

/** Entries per page of a player's feed. */
export const FEED_PAGE_SIZE = 25;

export type PlayerFeed = {
  gamertag: string; scope: ResolvedScope; seasons: number[];
  page: number; perPage: number; entries: FeedEntry[]; hasNext: boolean;
};

const DEFAULT_LIMIT = 25;

/**
 * Half-open `[from, to)`; `to` null means "no upper bound at all", which only
 * all-time has. An OPEN season's upper bound is `now`, not null — the plan's
 * window is `[started_at, coalesce(ended_at, now))`, so a row with a
 * future `occurred_at` (a mis-set `servers.clock_offset_ms`) is outside it.
 *
 * `seasonId` is the season this window came from, or null for all-time and
 * for an unknown season number. `raids` carries an authoritative `season_id`,
 * so raid reads key on it rather than on the timestamps.
 */
type Window = { from: Date; to: Date | null; seasonId: number | null };

/** An unknown season number: a window that contains no instant at all, so every aggregate is zero rather than everything. */
const EMPTY_WINDOW: Window = { from: new Date(0), to: new Date(0), seasonId: null };

/**
 * The window one scope names. "All" starts at the epoch rather than at the
 * first season's `started_at`: a kill the log recorded before season 1 opened
 * is still part of that player's all-time record.
 */
async function windowFor(db: Database, serverId: number, scope: ResolvedScope, now: Date): Promise<Window> {
  if (scope.kind === "all") return { from: new Date(0), to: null, seasonId: null };
  const [s] = await db.select({ id: seasons.id, startedAt: seasons.startedAt, endedAt: seasons.endedAt })
    .from(seasons).where(and(eq(seasons.serverId, serverId), eq(seasons.number, scope.number)));
  if (!s) return EMPTY_WINDOW;
  // ⚠️ `?? now`, not `?? null`: an open season ends at this instant.
  return { from: s.startedAt, to: s.endedAt ?? now, seasonId: s.id };
}

/**
 * `"current"` → the newest season on this server, or all-time when the server
 * has none. Resolved from the season list the caller has already fetched, so
 * it costs no extra query.
 */
function resolveScope(scope: StatScope, seasonList: number[]): ResolvedScope {
  if (scope.kind !== "current") return scope;
  const newest = seasonList[0];
  return newest === undefined ? { kind: "all" } : { kind: "season", number: newest };
}

/** Every season number on this server, newest first. */
async function seasonNumbers(db: Database, serverId: number): Promise<number[]> {
  const rows = await db.select({ number: seasons.number }).from(seasons)
    .where(eq(seasons.serverId, serverId)).orderBy(desc(seasons.number));
  return rows.map((r) => r.number);
}

/**
 * ⚠️ Timestamps go into these raw fragments as ISO strings with an explicit
 * `::timestamptz`. A bare `Date` in a `sql` template has no column to take
 * its type from, and postgres.js then tries to serialise it as text.
 */
const ts = (d: Date): SQL => sql`${d.toISOString()}::timestamptz`;
const tsOrInfinity = (d: Date | null): SQL => (d === null ? sql`'infinity'::timestamptz` : ts(d));

/** `occurred_at >= from and (to is null or occurred_at < to)`, as one predicate. */
const inWindow = (col: PgColumn, w: Window): SQL =>
  w.to === null ? sql`${col} >= ${ts(w.from)}` : sql`${col} >= ${ts(w.from)} and ${col} < ${ts(w.to)}`;

/** `dayz_id in (…)` for a clan board, or nothing at all for the public boards. An empty roster matches nobody. */
/**
 * Raids in scope. For a season, `raids.season_id` — authoritative, exact and
 * cheaper than the timestamps, which agree only when a season's `started_at`
 * / `ended_at` happen to bracket every raid it scored. For all-time the
 * window is `[epoch, ∞)` and this is a no-op; for an unknown season number it
 * is `EMPTY_WINDOW`, which matches nothing.
 */
const raidsInScope = (w: Window): SQL =>
  w.seasonId !== null ? eq(raids.seasonId, w.seasonId) : inWindow(raids.firstLowerAt, w);

const inRoster = (col: PgColumn, roster: string[] | null): SQL | undefined =>
  roster === null ? undefined : roster.length === 0 ? sql`false` : inArray(col, roster);

/** ⚠️ A kill BY another player: the self-kill exclusion every PvP read shares. */
const byAnotherPlayer = sql`${kills.killerDayzId} is not null and ${kills.killerDayzId} <> ${kills.victimDayzId}`;

const gamertagOf = (col: PgColumn) => sql<string>`coalesce(${players.gamertag}, ${col})`;

const round2 = (v: number) => Math.round(v * 100) / 100;

/** Counted rows keyed on one player column, joined to `players` for the name. */
async function countBoard(
  db: Database, col: PgColumn, table: PgTable, where: SQL, limit: number, offset = 0,
): Promise<BoardRow[]> {
  const value = sql<number>`count(*)::int`;
  const gamertag = gamertagOf(col);
  const rows = await db.select({ dayzId: sql<string>`${col}`, gamertag, value })
    .from(table)
    .leftJoin(players, eq(players.dayzId, col))
    .where(where)
    .groupBy(col, players.gamertag)
    .orderBy(desc(value), asc(gamertag))
    .limit(limit).offset(offset);
  return rows.map((r) => ({ dayzId: r.dayzId, gamertag: r.gamertag, value: Number(r.value) }));
}

/**
 * Seconds inside the window, per session row: clipped at both ends, and never
 * negative. An open session ends at `now`; an open window ends at `now` too.
 */
const clippedSeconds = (w: Window, now: Date) => sql<number>`greatest(0, extract(epoch from (
  least(coalesce(${playerSessions.disconnectedAt}, ${ts(now)}), ${tsOrInfinity(w.to)})
  - greatest(${playerSessions.connectedAt}, ${ts(w.from)})
)))`;

/** Sessions that touch the window at all. */
const sessionOverlaps = (w: Window, now: Date): SQL => sql`
  ${playerSessions.connectedAt} < ${tsOrInfinity(w.to)}
  and coalesce(${playerSessions.disconnectedAt}, ${ts(now)}) > ${ts(w.from)}`;

/**
 * Streaks, in time order over every PvP kill in the window. One pass: a
 * non-friendly kill extends the killer's run, and every PvP death — friendly
 * fire included, the deaths board's rule — ends the victim's. Returns each
 * player's best run; a player with no run has no row.
 */
async function bestStreaks(db: Database, serverId: number, w: Window): Promise<Map<string, number>> {
  const rows = await db.select({ killer: kills.killerDayzId, victim: kills.victimDayzId, friendlyFire: kills.friendlyFire })
    .from(kills)
    .where(and(eq(kills.serverId, serverId), byAnotherPlayer, inWindow(kills.occurredAt, w)))
    .orderBy(asc(kills.occurredAt), asc(kills.id));
  const run = new Map<string, number>();
  const best = new Map<string, number>();
  for (const r of rows) {
    if (!r.friendlyFire) {
      const n = (run.get(r.killer!) ?? 0) + 1;
      run.set(r.killer!, n);
      if (n > (best.get(r.killer!) ?? 0)) best.set(r.killer!, n);
    }
    run.set(r.victim, 0);
  }
  return best;
}

async function streakBoard(db: Database, serverId: number, w: Window, roster: string[] | null, limit: number, offset = 0): Promise<BoardRow[]> {
  const best = await bestStreaks(db, serverId, w);
  const ids = [...best.keys()].filter((id) => roster === null || roster.includes(id));
  if (ids.length === 0) return [];
  const names = await db.select({ dayzId: players.dayzId, gamertag: players.gamertag }).from(players).where(inArray(players.dayzId, ids));
  const nameOf = new Map(names.map((n) => [n.dayzId, n.gamertag]));
  return ids.map((id) => ({ dayzId: id, gamertag: nameOf.get(id) ?? id, value: best.get(id)! }))
    .sort((a, b) => b.value - a.value || a.gamertag.localeCompare(b.gamertag))
    .slice(offset, offset + limit);
}

/** ⚠️ A non-friendly PvP kill with a distance the log recorded — the only kill that counts for range. */
const rangedKill = and(byAnotherPlayer, eq(kills.friendlyFire, false), isNotNull(kills.distanceM))!;

/** Each killer's farthest kill (`distinct on`), then the farthest killers first. */
async function longestKillBoard(db: Database, serverId: number, w: Window, roster: string[] | null, limit: number, offset = 0): Promise<LongestKillRow[]> {
  const rows = await db.execute<{ dayz_id: string; gamertag: string; distance_m: string; weapon: string | null }>(sql`
    select f.killer_dayz_id as dayz_id, coalesce(p.gamertag, f.killer_dayz_id) as gamertag, f.distance_m, f.weapon
    from (
      select distinct on (${kills.killerDayzId}) ${kills.killerDayzId} as killer_dayz_id, ${kills.distanceM} as distance_m, ${kills.weapon} as weapon
      from ${kills}
      where ${and(eq(kills.serverId, serverId), rangedKill, inWindow(kills.occurredAt, w), inRoster(kills.killerDayzId, roster))}
      order by ${kills.killerDayzId}, ${kills.distanceM} desc, ${kills.occurredAt} desc
    ) f
    left join ${players} p on p.dayz_id = f.killer_dayz_id
    order by f.distance_m desc, gamertag asc
    limit ${limit} offset ${offset}`);
  return [...rows].map((r) => ({ dayzId: r.dayz_id, gamertag: r.gamertag, value: Number(r.distance_m), weapon: r.weapon }));
}

/** The builder's id lives in the event payload; the board keys on it the way the others key on a column. */
const builderId = sql<string>`${events.payload}->>'dayzId'`;
const builtInScope = (serverId: number, w: Window): SQL =>
  and(eq(events.serverId, serverId), eq(events.type, "base.built"), inWindow(events.occurredAt, w))!;

/** Build points: `count(*)` of `base.built` per builder, joined to `players` for the name. */
async function buildersBoard(db: Database, serverId: number, w: Window, roster: string[] | null, limit: number, offset = 0): Promise<BoardRow[]> {
  const value = sql<number>`count(*)::int`;
  const gamertag = sql<string>`coalesce(${players.gamertag}, ${builderId})`;
  const rosterWhere = roster === null ? undefined : roster.length === 0 ? sql`false` : sql`${builderId} in ${roster}`;
  const rows = await db.select({ dayzId: builderId, gamertag, value })
    .from(events)
    .leftJoin(players, eq(players.dayzId, builderId))
    .where(and(builtInScope(serverId, w), rosterWhere))
    .groupBy(builderId, players.gamertag)
    .orderBy(desc(value), asc(gamertag))
    .limit(limit).offset(offset);
  return rows.map((r) => ({ dayzId: r.dayzId, gamertag: r.gamertag, value: Number(r.value) }));
}

async function playTimeBoard(db: Database, serverId: number, w: Window, now: Date, roster: string[] | null, limit: number, offset = 0): Promise<BoardRow[]> {
  const value = sql<number>`sum(${clippedSeconds(w, now)})::bigint`;
  const gamertag = gamertagOf(playerSessions.dayzId);
  const rows = await db.select({ dayzId: playerSessions.dayzId, gamertag, value })
    .from(playerSessions)
    .leftJoin(players, eq(players.dayzId, playerSessions.dayzId))
    .where(and(eq(playerSessions.serverId, serverId), sessionOverlaps(w, now), inRoster(playerSessions.dayzId, roster)))
    .groupBy(playerSessions.dayzId, players.gamertag)
    .having(sql`sum(${clippedSeconds(w, now)}) > 0`)
    .orderBy(desc(value), asc(gamertag))
    .limit(limit).offset(offset);
  return rows.map((r) => ({ dayzId: r.dayzId, gamertag: r.gamertag, value: Number(r.value) }));
}

/**
 * The K/D board: players with at least `KD_MIN_KILLS` PvP kills in the
 * window, their PvP deaths in the same window, `kills / max(deaths, 1)`
 * rounded to 2 dp. The gate is a board rule only — a profile always shows
 * its own ratio.
 *
 * ⚠️ Friendly fire is NOT a K/D kill. Shooting a clanmate still counts on
 * the killers board and the friendly-fire board, but it earns nothing here,
 * on the row's `kills` or towards the gate — a K/D padded on your own roster
 * is not one. A friendly-fire DEATH is still a death: dead is dead. The
 * profile's `kd` follows the same rule.
 */
const kdKill = and(byAnotherPlayer, eq(kills.friendlyFire, false))!;
async function kdBoard(db: Database, serverId: number, w: Window, roster: string[] | null, limit: number, offset = 0): Promise<KdRow[]> {
  const killCount = sql<number>`count(*)::int`;
  const killerRows = await db.select({ dayzId: sql<string>`${kills.killerDayzId}`, gamertag: gamertagOf(kills.killerDayzId), kills: killCount })
    .from(kills)
    .leftJoin(players, eq(players.dayzId, kills.killerDayzId))
    .where(and(eq(kills.serverId, serverId), kdKill, inWindow(kills.occurredAt, w), inRoster(kills.killerDayzId, roster)))
    .groupBy(kills.killerDayzId, players.gamertag)
    .having(sql`count(*) >= ${KD_MIN_KILLS}`);
  if (killerRows.length === 0) return [];

  // ⚠️ `ids` is already a subset of the roster (it came out of the query
  // above, which carries the roster predicate), so this second query never
  // reaches a row outside the clan either. The killer is deliberately NOT
  // restricted: a member's deaths count whoever killed them.
  const ids = killerRows.map((r) => r.dayzId);
  const deathRows = await db.select({ dayzId: kills.victimDayzId, deaths: sql<number>`count(*)::int` })
    .from(kills)
    .where(and(eq(kills.serverId, serverId), byAnotherPlayer, inWindow(kills.occurredAt, w), inArray(kills.victimDayzId, ids)))
    .groupBy(kills.victimDayzId);
  const deathsOf = new Map(deathRows.map((r) => [r.dayzId, Number(r.deaths)]));

  return killerRows
    .map((r): KdRow => {
      const k = Number(r.kills);
      const deaths = deathsOf.get(r.dayzId) ?? 0;
      return { dayzId: r.dayzId, gamertag: r.gamertag, value: round2(k / Math.max(deaths, 1)), kills: k, deaths };
    })
    .sort((a, b) => b.value - a.value || a.gamertag.localeCompare(b.gamertag))
    .slice(offset, offset + limit);
}

/** One board's rows, by kind, in its own order, from `offset`. Every kind carries the same window and roster predicate. */
function boardRows(
  db: Database, kind: BoardKind, serverId: number, w: Window, now: Date, roster: string[] | null, limit: number, offset = 0,
): Promise<BoardRow[] | KdRow[] | LongestKillRow[]> {
  switch (kind) {
    case "raiders": return countBoard(db, raids.raiderDayzId, raids, and(
      eq(raids.serverId, serverId), raidsInScope(w), inRoster(raids.raiderDayzId, roster),
    )!, limit, offset);
    case "killers": return countBoard(db, kills.killerDayzId, kills, and(
      eq(kills.serverId, serverId), byAnotherPlayer, inWindow(kills.occurredAt, w), inRoster(kills.killerDayzId, roster),
    )!, limit, offset);
    // ⚠️ The ROSTER predicate is on the victim: a member's deaths count
    // whoever killed them, the same rule the K/D board's denominator uses.
    case "deaths": return countBoard(db, kills.victimDayzId, kills, and(
      eq(kills.serverId, serverId), byAnotherPlayer, inWindow(kills.occurredAt, w), inRoster(kills.victimDayzId, roster),
    )!, limit, offset);
    case "kd": return kdBoard(db, serverId, w, roster, limit, offset);
    case "playTime": return playTimeBoard(db, serverId, w, now, roster, limit, offset);
    case "friendlyFire": return countBoard(db, kills.killerDayzId, kills, and(
      eq(kills.serverId, serverId), eq(kills.friendlyFire, true), byAnotherPlayer,
      inWindow(kills.occurredAt, w), inRoster(kills.killerDayzId, roster),
    )!, limit, offset);
    case "builders": return buildersBoard(db, serverId, w, roster, limit, offset);
    case "streaks": return streakBoard(db, serverId, w, roster, limit, offset);
    case "longestKills": return longestKillBoard(db, serverId, w, roster, limit, offset);
  }
}

/** The current full clan of each of these players — one query, keyed by id. */
async function clansOf(db: Database, ids: string[]): Promise<RowClans> {
  const unique = [...new Set(ids)];
  if (unique.length === 0) return {};
  const rows = await db.select({ dayzId: factionMembers.dayzId, tag: factions.tag, texture: factions.texture })
    .from(factionMembers)
    .innerJoin(factions, eq(factions.id, factionMembers.factionId))
    .where(and(eq(factionMembers.status, "full"), inArray(factionMembers.dayzId, unique)));
  return Object.fromEntries(rows.map((r) => [r.dayzId, { tag: r.tag, texture: r.texture }]));
}

/** The server, the season list, and the window one scope resolves to — the preamble every board read shares. */
async function scopeWindow(db: Database, scope: StatScope, now: Date) {
  const serverId = await activeServerId(db);
  // ⚠️ The season list first, alone: `{ kind: "current" }` is resolved from it,
  // and the resolved scope is what every query below (and `Boards.scope`) uses.
  const seasonList = await seasonNumbers(db, serverId);
  const resolved = resolveScope(scope, seasonList);
  const w = await windowFor(db, serverId, resolved, now);
  return { serverId, seasonList, resolved, w };
}

/** The nine boards, optionally narrowed to one clan's roster. `roster === null` is the public board. */
async function boardsFor(db: Database, scope: StatScope, limit: number, now: Date, roster: string[] | null): Promise<Boards> {
  const { serverId, seasonList, resolved, w } = await scopeWindow(db, scope, now);
  const rows = (kind: BoardKind) => boardRows(db, kind, serverId, w, now, roster, limit);
  const [raiders, killers, deaths, kd, playTime, friendlyFire, builders, streaks, longestKills] = await Promise.all([
    rows("raiders"), rows("killers"), rows("deaths"), kdBoard(db, serverId, w, roster, limit), rows("playTime"),
    rows("friendlyFire"), rows("builders"), rows("streaks"), longestKillBoard(db, serverId, w, roster, limit),
  ]);
  const all = [raiders, killers, deaths, kd, playTime, friendlyFire, builders, streaks, longestKills];
  const clans = await clansOf(db, all.flatMap((rows) => rows.map((r) => r.dayzId)));
  return { scope: resolved, seasons: seasonList, clans, raiders, killers, deaths, kd, playTime, friendlyFire, builders, streaks, longestKills };
}

/**
 * One page of one board. Fetches one row past the page to learn whether a
 * next page exists — no count query. `page` is 1-based; the caller has
 * already turned an attacker-supplied value into a positive integer.
 */
async function boardPageFor(
  db: Database, kind: BoardKind, scope: StatScope, page: number, now: Date, roster: string[] | null, perPage: number,
): Promise<BoardPage> {
  const { seasonList, serverId, resolved, w } = await scopeWindow(db, scope, now);
  const offset = (page - 1) * perPage;
  const rows = await boardRows(db, kind, serverId, w, now, roster, perPage + 1, offset);
  const shown = rows.slice(0, perPage);
  return {
    scope: resolved, seasons: seasonList, kind, page, perPage,
    clans: await clansOf(db, shown.map((r) => r.dayzId)),
    rows: shown, hasNext: rows.length > perPage,
  };
}

/** One page of one public board. `perPage` is for tests; the site always pages by `BOARD_PAGE_SIZE`. */
export function boardPageDb(
  db: Database, kind: BoardKind, scope: StatScope, page: number, now: Date, perPage = BOARD_PAGE_SIZE,
): Promise<BoardPage> {
  return boardPageFor(db, kind, scope, page, now, null, perPage);
}

/** One page of one board, narrowed to the actor's own clan's current full roster, with `clanBoardDb`'s refusals. */
export async function clanBoardPageDb(
  db: Database, discordId: string, kind: BoardKind, scope: StatScope, page: number, now: Date, perPage = BOARD_PAGE_SIZE,
): Promise<BoardPage | ActorRefusal> {
  const roster = await clanRoster(db, discordId);
  if (typeof roster === "string") return roster;
  return boardPageFor(db, kind, scope, page, now, roster, perPage);
}

/** The public boards (spec §11). */
export function playerBoardsDb(db: Database, scope: StatScope, limit = DEFAULT_LIMIT, now: Date): Promise<Boards> {
  return boardsFor(db, scope, limit, now, null);
}

/**
 * The same boards, narrowed to the CURRENT full roster of the actor's own
 * clan. The clan is derived from the actor's link and roster row — the site
 * never names a faction id — and the roster lands in the WHERE clause of
 * every query, so no other clan's rows are ever fetched and discarded.
 */
export async function clanBoardDb(
  db: Database, discordId: string, scope: StatScope, limit = DEFAULT_LIMIT, now: Date,
): Promise<Boards | ActorRefusal> {
  const roster = await clanRoster(db, discordId);
  if (typeof roster === "string") return roster;
  return boardsFor(db, scope, limit, now, roster);
}

/** The current full roster of the actor's own clan, or why there is none. */
async function clanRoster(db: Database, discordId: string): Promise<string[] | ActorRefusal> {
  const a = await actorFor(db, discordId);
  if (isRefusal(a)) return a;
  const roster = await db.select({ dayzId: factionMembers.dayzId }).from(factionMembers)
    .where(and(eq(factionMembers.factionId, a.factionId), eq(factionMembers.status, "full")));
  return roster.map((r) => r.dayzId);
}

/**
 * Who this gamertag is. `identity_links` first (case-insensitive exact match;
 * the most recently verified when several links have carried the name), so
 * every linked player has a profile. Failing that, `players` — but only for a
 * character the log has actually seen kill, die or connect, so a name from a
 * killed-by list still resolves while a typo does not.
 */
async function resolvePlayer(db: Database, gamertag: string): Promise<{ dayzId: string; gamertag: string; linked: boolean } | null> {
  const [link] = await db.select({ dayzId: identityLinks.dayzId, gamertag: identityLinks.gamertag })
    .from(identityLinks).where(sql`lower(${identityLinks.gamertag}) = lower(${gamertag})`)
    .orderBy(desc(identityLinks.verifiedAt)).limit(1);
  if (link) return { ...link, linked: true };

  const [p] = await db.select({ dayzId: players.dayzId, gamertag: players.gamertag })
    .from(players)
    .where(sql`lower(${players.gamertag}) = lower(${gamertag}) and (
      exists (select 1 from ${kills} k where k.victim_dayz_id = ${players.dayzId} or k.killer_dayz_id = ${players.dayzId})
      or exists (select 1 from ${playerSessions} s where s.dayz_id = ${players.dayzId}))`)
    .orderBy(desc(players.lastSeenAt)).limit(1);
  return p ? { ...p, linked: false } : null;
}

/** `count(*)` over `kills` under one predicate. */
async function killCount(db: Database, where: SQL): Promise<number> {
  const [row] = await db.select({ n: sql<number>`count(*)::int` }).from(kills).where(where);
  return Number(row?.n ?? 0);
}

/** One side of the head-to-head lists: who they killed, or who killed them. */
async function opponents(db: Database, other: PgColumn, where: SQL): Promise<{ gamertag: string; count: number }[]> {
  const count = sql<number>`count(*)::int`;
  const gamertag = gamertagOf(other);
  const rows = await db.select({ gamertag, count })
    .from(kills).leftJoin(players, eq(players.dayzId, other))
    .where(where).groupBy(other, players.gamertag)
    .orderBy(desc(count), asc(gamertag));
  return rows.map((r) => ({ gamertag: r.gamertag, count: Number(r.count) }));
}

/**
 * Upkeep raises (spec §11). §11 says "`flag.raised` by the player at their
 * own clan's declaration with the clan's texture while a full member";
 * declaration history is not kept (the rows are deleted on release), so the
 * pole check is dropped and what remains is: a `flag.raised` by this player
 * whose texture is the texture of a clan they were a FULL member of at
 * `occurred_at`, resolved through `membership_history`. A member raising
 * their own colors at a pole that is not the base therefore counts — that
 * raise already triggers a rebind proposal, so it is rare and visible.
 */
async function upkeepRaiseCount(db: Database, serverId: number, dayzId: string, w: Window): Promise<number> {
  const [row] = await db.select({ n: sql<number>`count(distinct ${events.id})::int` })
    .from(events)
    .innerJoin(membershipHistory, and(
      eq(membershipHistory.serverId, events.serverId),
      eq(membershipHistory.dayzId, dayzId),
      sql`${membershipHistory.joinedAt} <= ${events.occurredAt}`,
      sql`(${membershipHistory.leftAt} is null or ${events.occurredAt} < ${membershipHistory.leftAt})`,
    ))
    .innerJoin(factions, and(eq(factions.id, membershipHistory.factionId), sql`${factions.texture} = ${events.payload}->>'texture'`))
    .where(and(
      eq(events.serverId, serverId), eq(events.type, "flag.raised"),
      sql`${events.payload}->>'dayzId' = ${dayzId}`,
      inWindow(events.occurredAt, w),
    ));
  return Number(row?.n ?? 0);
}

/** One player's page (spec §11), every number bounded by the scope's window. */
export async function playerProfileDb(db: Database, gamertag: string, scope: StatScope, now: Date): Promise<PlayerProfile | null> {
  const who = await resolvePlayer(db, gamertag);
  if (!who) return null;
  const { dayzId } = who;
  const serverId = await activeServerId(db);
  // ⚠️ Same as `boardsFor`: the season list first, so `{ kind: "current" }`
  // resolves here rather than costing the caller a whole probe profile.
  const seasonList = await seasonNumbers(db, serverId);
  const resolved = resolveScope(scope, seasonList);
  const w = await windowFor(db, serverId, resolved, now);

  const inW = inWindow(kills.occurredAt, w);
  const mine = eq(kills.serverId, serverId);

  const [
    lastSeen, session, pvpKills, pvpDeaths, killed, killedBy,
    friendlyFireKills, friendlyFireDeaths, raidCredits, upkeepRaises, buildPoints, streaks, longest, clanHistory, clanNow, encounters,
  ] = await Promise.all([
    db.select({ lastSeenAt: players.lastSeenAt }).from(players).where(eq(players.dayzId, dayzId)),
    db.select({
      seconds: sql<number>`coalesce(sum(${clippedSeconds(w, now)}), 0)::bigint`,
      sessions: sql<number>`count(*)::int`,
    }).from(playerSessions)
      .where(and(eq(playerSessions.serverId, serverId), eq(playerSessions.dayzId, dayzId), sessionOverlaps(w, now))),
    killCount(db, and(mine, inW, eq(kills.killerDayzId, dayzId), sql`${kills.victimDayzId} <> ${dayzId}`)!),
    killCount(db, and(mine, inW, eq(kills.victimDayzId, dayzId), isNotNull(kills.killerDayzId), sql`${kills.killerDayzId} <> ${dayzId}`)!),
    opponents(db, kills.victimDayzId,
      and(mine, inW, eq(kills.killerDayzId, dayzId), sql`${kills.victimDayzId} <> ${dayzId}`)!),
    opponents(db, kills.killerDayzId,
      and(mine, inW, eq(kills.victimDayzId, dayzId), isNotNull(kills.killerDayzId), sql`${kills.killerDayzId} <> ${dayzId}`)!),
    killCount(db, and(mine, inW, eq(kills.friendlyFire, true), eq(kills.killerDayzId, dayzId), sql`${kills.victimDayzId} <> ${dayzId}`)!),
    killCount(db, and(mine, inW, eq(kills.friendlyFire, true), eq(kills.victimDayzId, dayzId), sql`${kills.killerDayzId} <> ${dayzId}`)!),
    db.select({ n: sql<number>`count(*)::int` }).from(raids)
      .where(and(eq(raids.serverId, serverId), eq(raids.raiderDayzId, dayzId), raidsInScope(w))),
    upkeepRaiseCount(db, serverId, dayzId, w),
    db.select({ n: sql<number>`count(*)::int` }).from(events).where(and(builtInScope(serverId, w), sql`${builderId} = ${dayzId}`)),
    bestStreaks(db, serverId, w),
    db.select({ distanceM: kills.distanceM, weapon: kills.weapon }).from(kills)
      .where(and(mine, inW, rangedKill, eq(kills.killerDayzId, dayzId)))
      .orderBy(desc(kills.distanceM), desc(kills.occurredAt)).limit(1),
    // ⚠️ The whole history, not the window's slice: "which clans has this
    // player belonged to" is not a per-season number.
    db.select({ tag: factions.tag, name: factions.name, joinedAt: membershipHistory.joinedAt, leftAt: membershipHistory.leftAt })
      .from(membershipHistory).innerJoin(factions, eq(factions.id, membershipHistory.factionId))
      .where(and(eq(membershipHistory.serverId, serverId), eq(membershipHistory.dayzId, dayzId)))
      .orderBy(desc(membershipHistory.joinedAt)),
    db.select({ tag: factions.tag, name: factions.name, texture: factions.texture })
      .from(factionMembers).innerJoin(factions, eq(factions.id, factionMembers.factionId))
      .where(and(eq(factionMembers.dayzId, dayzId), eq(factionMembers.status, "full"))).limit(1),
    encountersOf(db, serverId, dayzId, w),
  ]);

  return {
    dayzId, gamertag: who.gamertag, linked: who.linked, scope: resolved, seasons: seasonList,
    playTimeSeconds: Number(session[0]?.seconds ?? 0),
    sessions: Number(session[0]?.sessions ?? 0),
    lastSeenAt: lastSeen[0]?.lastSeenAt ?? null,
    pvpKills, pvpDeaths,
    // The board's rule: friendly fire earns nothing towards K/D (see kdBoard).
    kd: pvpKills === 0 && pvpDeaths === 0 ? null : round2((pvpKills - friendlyFireKills) / Math.max(pvpDeaths, 1)),
    killedBy, killed,
    friendlyFireKills, friendlyFireDeaths,
    raidCredits: Number(raidCredits[0]?.n ?? 0),
    upkeepRaises,
    buildPoints: Number(buildPoints[0]?.n ?? 0),
    bestStreak: streaks.get(dayzId) ?? 0,
    longestKill: longest[0] ? { distanceM: Number(longest[0].distanceM), weapon: longest[0].weapon } : null,
    clanHistory,
    clan: clanNow[0] ?? null,
    encounters,
  };
}

/** Every PvP kill in the window with this player on either side, newest first, both names resolved. */
async function encountersOf(db: Database, serverId: number, dayzId: string, w: Window): Promise<Encounter[]> {
  const rows = await db.select({
    at: kills.occurredAt, killer: kills.killerDayzId, victim: kills.victimDayzId,
    weapon: kills.weapon, distanceM: kills.distanceM, friendlyFire: kills.friendlyFire,
  }).from(kills)
    .where(and(
      eq(kills.serverId, serverId), byAnotherPlayer, inWindow(kills.occurredAt, w),
      sql`(${kills.killerDayzId} = ${dayzId} or ${kills.victimDayzId} = ${dayzId})`,
    ))
    .orderBy(desc(kills.occurredAt), desc(kills.id));
  if (rows.length === 0) return [];
  const ids = [...new Set(rows.flatMap((r) => [r.killer!, r.victim]))];
  const names = await db.select({ dayzId: players.dayzId, gamertag: players.gamertag }).from(players).where(inArray(players.dayzId, ids));
  const nameOf = new Map(names.map((n) => [n.dayzId, n.gamertag]));
  return rows.map((r) => ({
    at: r.at, killer: nameOf.get(r.killer!) ?? r.killer!, victim: nameOf.get(r.victim) ?? r.victim,
    weapon: r.weapon, distanceM: r.distanceM === null ? null : Number(r.distanceM), friendlyFire: r.friendlyFire,
  }));
}

/**
 * One page of a player's feed (newest first): kills, deaths, raids, colours
 * raised, and build steps / dismantles grouped by hour — one `union all`,
 * every branch bounded by the window, ordered and paged in SQL. Fetches one
 * row past the page for `hasNext`. Null when the log has never seen the name.
 */
export async function playerFeedDb(
  db: Database, gamertag: string, scope: StatScope, page: number, now: Date, perPage = FEED_PAGE_SIZE,
): Promise<PlayerFeed | null> {
  const who = await resolvePlayer(db, gamertag);
  if (!who) return null;
  const { dayzId } = who;
  const { serverId, seasonList, resolved, w } = await scopeWindow(db, scope, now);
  const offset = (page - 1) * perPage;
  const me = sql`${dayzId}`;

  type Raw = {
    kind: FeedEntry["kind"]; at: Date; other: string | null; weapon: string | null; distance_m: string | null;
    friendly_fire: boolean; cause: string | null; tag: string | null; name: string | null; n: number;
  };
  const rows = await db.execute<Raw>(sql`
    select kind, at, other, weapon, distance_m, friendly_fire, cause, tag, name, n from (
      select 'kill' as kind, ${kills.occurredAt} as at, coalesce(${players.gamertag}, ${kills.victimDayzId}) as other,
        ${kills.weapon} as weapon, ${kills.distanceM} as distance_m, ${kills.friendlyFire} as friendly_fire,
        ${kills.cause} as cause, null::text as tag, null::text as name, 1 as n
      from ${kills} left join ${players} on ${players.dayzId} = ${kills.victimDayzId}
      where ${kills.serverId} = ${serverId} and ${kills.killerDayzId} = ${me} and ${kills.victimDayzId} <> ${me} and ${inWindow(kills.occurredAt, w)}
      union all
      select 'death', ${kills.occurredAt},
        case when ${kills.killerDayzId} is null or ${kills.killerDayzId} = ${kills.victimDayzId} then null else coalesce(${players.gamertag}, ${kills.killerDayzId}) end,
        ${kills.weapon}, ${kills.distanceM}, ${kills.friendlyFire}, ${kills.cause}, null, null, 1
      from ${kills} left join ${players} on ${players.dayzId} = ${kills.killerDayzId}
      where ${kills.serverId} = ${serverId} and ${kills.victimDayzId} = ${me} and ${inWindow(kills.occurredAt, w)}
      union all
      select 'raid', ${raids.firstLowerAt}, null, null, null, false, null, ${factions.tag}, ${factions.name}, 1
      from ${raids} join ${factions} on ${factions.id} = ${raids.victimFactionId}
      where ${raids.serverId} = ${serverId} and ${raids.raiderDayzId} = ${me} and ${raidsInScope(w)}
      union all
      select 'raised', ${events.occurredAt}, null, null, null, false, null, null, null, 1
      from ${events}
      where ${events.serverId} = ${serverId} and ${events.type} = 'flag.raised' and ${events.payload}->>'dayzId' = ${me} and ${inWindow(events.occurredAt, w)}
      union all
      select case when ${events.type} = 'base.built' then 'built' else 'dismantled' end, max(${events.occurredAt}), null, null, null, false, null, null, null, count(*)::int
      from ${events}
      where ${events.serverId} = ${serverId} and ${events.type} in ('base.built', 'base.dismantled') and ${events.payload}->>'dayzId' = ${me} and ${inWindow(events.occurredAt, w)}
      group by ${events.type}, date_trunc('hour', ${events.occurredAt})
    ) feed
    order by at desc
    limit ${perPage + 1} offset ${offset}`);

  const all = [...rows].map((r): FeedEntry => {
    const at = new Date(r.at);
    const distanceM = r.distance_m === null ? null : Number(r.distance_m);
    switch (r.kind) {
      case "kill": return { kind: "kill", at, other: r.other!, weapon: r.weapon, distanceM, friendlyFire: r.friendly_fire, cause: r.cause };
      case "death": return { kind: "death", at, other: r.other, weapon: r.weapon, distanceM, friendlyFire: r.friendly_fire, cause: r.cause };
      case "raid": return { kind: "raid", at, victim: { tag: r.tag!, name: r.name! } };
      case "raised": return { kind: "raised", at };
      case "built": return { kind: "built", at, steps: Number(r.n) };
      case "dismantled": return { kind: "dismantled", at, steps: Number(r.n) };
    }
  });
  return {
    gamertag: who.gamertag, scope: resolved, seasons: seasonList, page, perPage,
    entries: all.slice(0, perPage), hasNext: all.length > perPage,
  };
}
