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
export type Boards = {
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
  db: Database, col: PgColumn, table: PgTable, where: SQL, limit: number,
): Promise<BoardRow[]> {
  const value = sql<number>`count(*)::int`;
  const gamertag = gamertagOf(col);
  const rows = await db.select({ dayzId: sql<string>`${col}`, gamertag, value })
    .from(table)
    .leftJoin(players, eq(players.dayzId, col))
    .where(where)
    .groupBy(col, players.gamertag)
    .orderBy(desc(value), asc(gamertag))
    .limit(limit);
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

async function streakBoard(db: Database, serverId: number, w: Window, roster: string[] | null, limit: number): Promise<BoardRow[]> {
  const best = await bestStreaks(db, serverId, w);
  const ids = [...best.keys()].filter((id) => roster === null || roster.includes(id));
  if (ids.length === 0) return [];
  const names = await db.select({ dayzId: players.dayzId, gamertag: players.gamertag }).from(players).where(inArray(players.dayzId, ids));
  const nameOf = new Map(names.map((n) => [n.dayzId, n.gamertag]));
  return ids.map((id) => ({ dayzId: id, gamertag: nameOf.get(id) ?? id, value: best.get(id)! }))
    .sort((a, b) => b.value - a.value || a.gamertag.localeCompare(b.gamertag))
    .slice(0, limit);
}

/** ⚠️ A non-friendly PvP kill with a distance the log recorded — the only kill that counts for range. */
const rangedKill = and(byAnotherPlayer, eq(kills.friendlyFire, false), isNotNull(kills.distanceM))!;

/** Each killer's farthest kill (`distinct on`), then the farthest killers first. */
async function longestKillBoard(db: Database, serverId: number, w: Window, roster: string[] | null, limit: number): Promise<LongestKillRow[]> {
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
    limit ${limit}`);
  return [...rows].map((r) => ({ dayzId: r.dayz_id, gamertag: r.gamertag, value: Number(r.distance_m), weapon: r.weapon }));
}

/** The builder's id lives in the event payload; the board keys on it the way the others key on a column. */
const builderId = sql<string>`${events.payload}->>'dayzId'`;
const builtInScope = (serverId: number, w: Window): SQL =>
  and(eq(events.serverId, serverId), eq(events.type, "base.built"), inWindow(events.occurredAt, w))!;

/** Build points: `count(*)` of `base.built` per builder, joined to `players` for the name. */
async function buildersBoard(db: Database, serverId: number, w: Window, roster: string[] | null, limit: number): Promise<BoardRow[]> {
  const value = sql<number>`count(*)::int`;
  const gamertag = sql<string>`coalesce(${players.gamertag}, ${builderId})`;
  const rosterWhere = roster === null ? undefined : roster.length === 0 ? sql`false` : sql`${builderId} in ${roster}`;
  const rows = await db.select({ dayzId: builderId, gamertag, value })
    .from(events)
    .leftJoin(players, eq(players.dayzId, builderId))
    .where(and(builtInScope(serverId, w), rosterWhere))
    .groupBy(builderId, players.gamertag)
    .orderBy(desc(value), asc(gamertag))
    .limit(limit);
  return rows.map((r) => ({ dayzId: r.dayzId, gamertag: r.gamertag, value: Number(r.value) }));
}

async function playTimeBoard(db: Database, serverId: number, w: Window, now: Date, roster: string[] | null, limit: number): Promise<BoardRow[]> {
  const value = sql<number>`sum(${clippedSeconds(w, now)})::bigint`;
  const gamertag = gamertagOf(playerSessions.dayzId);
  const rows = await db.select({ dayzId: playerSessions.dayzId, gamertag, value })
    .from(playerSessions)
    .leftJoin(players, eq(players.dayzId, playerSessions.dayzId))
    .where(and(eq(playerSessions.serverId, serverId), sessionOverlaps(w, now), inRoster(playerSessions.dayzId, roster)))
    .groupBy(playerSessions.dayzId, players.gamertag)
    .having(sql`sum(${clippedSeconds(w, now)}) > 0`)
    .orderBy(desc(value), asc(gamertag))
    .limit(limit);
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
async function kdBoard(db: Database, serverId: number, w: Window, roster: string[] | null, limit: number): Promise<KdRow[]> {
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
    .slice(0, limit);
}

/** The nine boards, optionally narrowed to one clan's roster. `roster === null` is the public board. */
async function boardsFor(db: Database, scope: StatScope, limit: number, now: Date, roster: string[] | null): Promise<Boards> {
  const serverId = await activeServerId(db);
  // ⚠️ The season list first, alone: `{ kind: "current" }` is resolved from it,
  // and the resolved scope is what every query below (and `Boards.scope`) uses.
  const seasonList = await seasonNumbers(db, serverId);
  const resolved = resolveScope(scope, seasonList);
  const w = await windowFor(db, serverId, resolved, now);

  const [raiders, killers, deaths, kd, playTime, friendlyFire, builders, streaks, longestKills] = await Promise.all([
    countBoard(db, raids.raiderDayzId, raids, and(
      eq(raids.serverId, serverId), raidsInScope(w), inRoster(raids.raiderDayzId, roster),
    )!, limit),
    countBoard(db, kills.killerDayzId, kills, and(
      eq(kills.serverId, serverId), byAnotherPlayer, inWindow(kills.occurredAt, w), inRoster(kills.killerDayzId, roster),
    )!, limit),
    // ⚠️ The ROSTER predicate is on the victim: a member's deaths count
    // whoever killed them, the same rule the K/D board's denominator uses.
    countBoard(db, kills.victimDayzId, kills, and(
      eq(kills.serverId, serverId), byAnotherPlayer, inWindow(kills.occurredAt, w), inRoster(kills.victimDayzId, roster),
    )!, limit),
    kdBoard(db, serverId, w, roster, limit),
    playTimeBoard(db, serverId, w, now, roster, limit),
    countBoard(db, kills.killerDayzId, kills, and(
      eq(kills.serverId, serverId), eq(kills.friendlyFire, true), byAnotherPlayer,
      inWindow(kills.occurredAt, w), inRoster(kills.killerDayzId, roster),
    )!, limit),
    buildersBoard(db, serverId, w, roster, limit),
    streakBoard(db, serverId, w, roster, limit),
    longestKillBoard(db, serverId, w, roster, limit),
  ]);

  return { scope: resolved, seasons: seasonList, raiders, killers, deaths, kd, playTime, friendlyFire, builders, streaks, longestKills };
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
  const a = await actorFor(db, discordId);
  if (isRefusal(a)) return a;
  const roster = await db.select({ dayzId: factionMembers.dayzId }).from(factionMembers)
    .where(and(eq(factionMembers.factionId, a.factionId), eq(factionMembers.status, "full")));
  return boardsFor(db, scope, limit, now, roster.map((r) => r.dayzId));
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
    friendlyFireKills, friendlyFireDeaths, raidCredits, upkeepRaises, buildPoints, streaks, longest, clanHistory,
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
  };
}
