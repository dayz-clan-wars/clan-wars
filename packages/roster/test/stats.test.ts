import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import {
  createClient, runMigrations, requireTestDatabaseUrl,
  servers, admFiles, events, players, identityLinks, factionMembers, seasons,
  kills, playerSessions, membershipHistory, raids,
  type Database,
} from "@factions/db";
import { sql } from "drizzle-orm";
import { KD_MIN_KILLS } from "@factions/domain";
import { playerBoardsDb, playerProfileDb, clanBoardDb } from "../src/stats";
import { seedFaction } from "./seed";

const URL = requireTestDatabaseUrl();

/**
 * The fixture's instants. Season 1 runs t0 → t50 (closed); season 2 is open
 * from t50. `now` is well after both, so an open session that connected at
 * `now` contributes no play time to any window.
 */
const t0 = new Date("2026-01-01T00:00:00Z");
const t50 = new Date("2026-03-01T00:00:00Z");
const now = new Date("2026-06-01T12:00:00Z");
const HOUR = 3_600_000;
const h = (base: Date, n: number) => new Date(base.getTime() + n * HOUR);

const A = "dayz-A";
const B = "dayz-B";
const R = "dayz-R";
const S = "dayz-S";
const P = "dayz-P";
const N = "dayz-N";

const aLastSeen = h(now, -2);

/**
 * ⚠️ The sessions that make the window clip load-bearing. Without these two
 * every session sits wholly inside one window and an unclipped `sum` would
 * pass every assertion below.
 */
const straddleFrom = h(t50, -1);   // closed, and it crosses the season boundary
const straddleTo = h(t50, 2);
const openFrom = h(t50, -2);       // still open at `now`, and it starts in season 1

const secs = (a: Date, b: Date) => Math.round((b.getTime() - a.getTime()) / 1000);

/** A's play time, per window, worked out from the instants rather than restated. */
const CLOSED_IN_SEASON_1 = 3600 + 1800;
const PLAY_ALL = CLOSED_IN_SEASON_1 + secs(straddleFrom, straddleTo) + secs(openFrom, now);
const PLAY_SEASON_1 = CLOSED_IN_SEASON_1 + secs(straddleFrom, t50) + secs(openFrom, t50);
const PLAY_SEASON_2 = secs(t50, straddleTo) + secs(t50, now);

const ALL = { kind: "all" } as const;
const SEASON_1 = { kind: "season", number: 1 } as const;
const SEASON_2 = { kind: "season", number: 2 } as const;

describe("roster player stats", () => {
  let db: Database;
  let serverId = 0;
  let admFileId = 0;
  let lineIndex = 0;
  let bearId = 0;
  let wolfId = 0;

  const mkEvent = async (a: { type: string; at: Date; payload?: unknown }) => {
    const [ev] = await db.insert(events).values({
      serverId, admFileId, lineIndex: lineIndex++, type: a.type as never, occurredAt: a.at, payload: a.payload ?? {},
    }).returning();
    return ev!.id;
  };

  const mkKill = async (a: {
    at: Date; victim: string; killer: string | null; cause?: string;
    victimFactionId?: number | null; killerFactionId?: number | null; friendlyFire?: boolean;
  }) => {
    const eventId = await mkEvent({ type: a.killer ? "player.killed" : "player.died", at: a.at });
    await db.insert(kills).values({
      serverId, eventId, occurredAt: a.at, victimDayzId: a.victim, killerDayzId: a.killer,
      weapon: null, distanceM: null, cause: a.cause ?? (a.killer ? "pvp" : "infected"),
      victimFactionId: a.victimFactionId ?? null, killerFactionId: a.killerFactionId ?? null,
      friendlyFire: a.friendlyFire ?? false,
    });
  };

  const mkSession = async (a: { dayzId: string; from: Date; to: Date | null }) => {
    const eventId = await mkEvent({ type: "player.connected", at: a.from });
    await db.insert(playerSessions).values({
      serverId, dayzId: a.dayzId, connectedAt: a.from, connectEventId: eventId,
      disconnectedAt: a.to, closeReason: a.to ? "disconnect" : null,
    });
  };

  const mkRaid = async (a: { seasonId: number; at: Date; raider: string }) => {
    const eventId = await mkEvent({ type: "flag.lowered", at: a.at });
    await db.insert(raids).values({
      seasonId: a.seasonId, serverId, victimFactionId: wolfId, raiderDayzId: a.raider, raiderFactionId: bearId,
      firstLowerEventId: eventId, firstLowerAt: a.at, lastLowerAt: a.at, lastLowerEventId: eventId,
      lowerCount: 1, points: 100, victimRankAtLower: null, rankedCountAtLower: 0, weekStart: t0,
    });
  };

  // ⚠️ One client for the file. A `createClient` per test leaks its pool and
  // the suite runs the server out of connections part way through.
  beforeAll(async () => {
    db = createClient(URL);
    await runMigrations(db);
  });

  beforeEach(async () => {
    await db.transaction(async (tx) => {
      await tx.execute(sql`set local client_min_messages = warning`);
      await tx.execute(sql`truncate table kills, player_sessions, membership_history, clan_pins, intruder_sightings, player_positions, clan_notices, war_log_events, season_results, alpha_weeks, defenses, season_standings, raids, seasons, faction_events, faction_members, declarations, poles, identity_links, consumer_cursors, events, raw_lines, adm_files, factions, players, servers restart identity cascade`);
    });
    const [s] = await db.insert(servers).values({ name: "S", map: "livonia", clockOffsetMs: 0, active: true }).returning();
    serverId = s!.id;
    const [f] = await db.insert(admFiles).values({ serverId, filename: "f.ADM", bootAt: t0, linesIngested: 0, complete: true }).returning();
    admFileId = f!.id;
    lineIndex = 0;

    // Season 1 closed at t50; season 2 open from t50.
    await db.insert(seasons).values([
      { serverId, number: 1, startedAt: t0, endedAt: t50 },
      { serverId, number: 2, startedAt: t50, endedAt: null },
    ]);

    const bear = await seedFaction(db, { serverId, tag: "BEAR", name: "BEAR", texture: "Flag_Bear", poleKey: "BEAR:0:0", x: 1000, z: 1000, leaderDiscordId: "dA", createdAt: t0, activatedAt: t0 });
    const wolf = await seedFaction(db, { serverId, tag: "WOLF", name: "WOLF", texture: "Flag_Wolf", poleKey: "WOLF:0:0", x: 9000, z: 9000, leaderDiscordId: "dR", createdAt: t0, activatedAt: t0 });
    bearId = bear.id;
    wolfId = wolf.id;

    await db.insert(players).values([
      { dayzId: A, gamertag: "Alpha", firstSeenAt: t0, lastSeenAt: aLastSeen },
      { dayzId: B, gamertag: "Bravo", firstSeenAt: t0, lastSeenAt: t50 },
      { dayzId: R, gamertag: "Romeo", firstSeenAt: t0, lastSeenAt: t50 },
      { dayzId: S, gamertag: "Stranger", firstSeenAt: t0, lastSeenAt: t50 },
      { dayzId: P, gamertag: "Papa", firstSeenAt: t0, lastSeenAt: t50 },
      { dayzId: N, gamertag: "November", firstSeenAt: t0, lastSeenAt: t50 },
    ]);
    await db.insert(identityLinks).values([
      { discordId: "dA", dayzId: A, gamertag: "Alpha", verifiedAt: t0 },
      { discordId: "dB", dayzId: B, gamertag: "Bravo", verifiedAt: t0 },
      { discordId: "dR", dayzId: R, gamertag: "Romeo", verifiedAt: t0 },
      { discordId: "dP", dayzId: P, gamertag: "Papa", verifiedAt: t0 },
      { discordId: "dN", dayzId: N, gamertag: "November", verifiedAt: t0 },
    ]);
    await db.insert(factionMembers).values([
      { factionId: bearId, serverId, dayzId: A, discordId: "dA", role: "leader", joinedAt: t0, status: "full" },
      { factionId: bearId, serverId, dayzId: B, discordId: "dB", role: "member", joinedAt: t0, status: "full" },
      { factionId: bearId, serverId, dayzId: P, discordId: "dP", role: "member", joinedAt: t0, status: "pending", pendingSince: t0 },
      { factionId: wolfId, serverId, dayzId: R, discordId: "dR", role: "leader", joinedAt: t0, status: "full" },
    ]);
    const joinedAt = h(t0, -2);
    await db.insert(membershipHistory).values([
      { serverId, factionId: bearId, dayzId: A, joinedAt, leftAt: null },
      // ⚠️ B left and rejoined: the closed span is what makes `left_at` matter.
      { serverId, factionId: bearId, dayzId: B, joinedAt, leftAt: h(t0, 60) },
      { serverId, factionId: bearId, dayzId: B, joinedAt: h(t0, 70), leftAt: null },
      { serverId, factionId: wolfId, dayzId: R, joinedAt, leftAt: null },
    ]);

    // A kills R twelve times in season 1.
    for (let i = 1; i <= 12; i++) {
      await mkKill({ at: h(t0, i), victim: R, killer: A, victimFactionId: wolfId, killerFactionId: bearId });
    }
    // R kills A three times in season 2.
    for (let i = 1; i <= 3; i++) {
      await mkKill({ at: h(t50, i), victim: A, killer: R, victimFactionId: bearId, killerFactionId: wolfId });
    }
    // ⚠️ A's friendly kill of B happened BEFORE season 1 opened: it is on the
    // all-time boards and on neither season's.
    await mkKill({ at: h(t0, -1), victim: B, killer: A, victimFactionId: bearId, killerFactionId: bearId, friendlyFire: true });
    // Deaths with no killer: never PvP.
    await mkKill({ at: h(t0, 21), victim: A, killer: null });
    await mkKill({ at: h(t0, 22), victim: S, killer: null });
    // A self-kill: never a PvP kill and never a PvP death.
    await mkKill({ at: h(t50, 4), victim: R, killer: R, victimFactionId: wolfId, killerFactionId: wolfId });

    // A's play time: 1 h + 30 min wholly inside season 1, one closed session
    // that straddles the season boundary, and one still open at `now`.
    // ⚠️ `player_sessions_open_uniq` allows one open session per player, so the
    // open one is the boundary-crossing one — it is clipped at BOTH ends.
    await mkSession({ dayzId: A, from: h(t0, 30), to: h(t0, 31) });
    await mkSession({ dayzId: A, from: h(t0, 40), to: new Date(h(t0, 40).getTime() + 1800_000) });
    await mkSession({ dayzId: A, from: straddleFrom, to: straddleTo });
    await mkSession({ dayzId: A, from: openFrom, to: null });

    const [s2] = await db.select({ id: seasons.id }).from(seasons).where(sql`${seasons.number} = 2`);
    await mkRaid({ seasonId: s2!.id, at: h(t50, 5), raider: A });
    await mkRaid({ seasonId: s2!.id, at: h(t50, 6), raider: A });

    // Upkeep raises: A raises BEAR's own texture twice in season 1 and once in
    // season 2; the Flag_Wolf raise is not their clan's colors.
    await mkEvent({ type: "flag.raised", at: h(t0, 50), payload: { dayzId: A, gamertag: "Alpha", texture: "Flag_Bear", poleKey: "BEAR:0:0" } });
    await mkEvent({ type: "flag.raised", at: h(t0, 51), payload: { dayzId: A, gamertag: "Alpha", texture: "Flag_Bear", poleKey: "BEAR:0:0" } });
    await mkEvent({ type: "flag.raised", at: h(t50, 10), payload: { dayzId: A, gamertag: "Alpha", texture: "Flag_Bear", poleKey: "BEAR:0:0" } });
    await mkEvent({ type: "flag.raised", at: h(t0, 52), payload: { dayzId: A, gamertag: "Alpha", texture: "Flag_Wolf", poleKey: "WOLF:0:0" } });
    // ⚠️ A raised BEAR's colors an hour before their membership span opens: not
    // an upkeep raise, and the only row that exercises `joined_at <= occurred_at`.
    await mkEvent({ type: "flag.raised", at: h(t0, -3), payload: { dayzId: A, gamertag: "Alpha", texture: "Flag_Bear", poleKey: "BEAR:0:0" } });
    // Build points: A builds three steps in season 1 and one in season 2; R
    // (WOLF) two in season 2; N (no clan) one in season 1. A dismantle is not a step.
    for (let i = 10; i <= 12; i++) await mkEvent({ type: "base.built", at: h(t0, i), payload: { dayzId: A, gamertag: "Alpha", action: "built", part: "wall_base_down", structure: "Fence" } });
    await mkEvent({ type: "base.built", at: h(t50, 7), payload: { dayzId: A, gamertag: "Alpha", action: "built", part: "wall_gate", structure: "Fence" } });
    await mkEvent({ type: "base.built", at: h(t50, 8), payload: { dayzId: R, gamertag: "Romeo", action: "built", part: "base", structure: "Fence" } });
    await mkEvent({ type: "base.built", at: h(t50, 9), payload: { dayzId: R, gamertag: "Romeo", action: "built", part: "level_1_base", structure: "Watchtower" } });
    await mkEvent({ type: "base.built", at: h(t0, 13), payload: { dayzId: N, gamertag: "November", action: "built", part: "base", structure: "Fence" } });
    await mkEvent({ type: "base.dismantled", at: h(t0, 14), payload: { dayzId: A, gamertag: "Alpha", action: "dismantled", part: "wall_base_down", structure: "Fence" } });
    // B: inside the first span, in the gap after they left, inside the second.
    await mkEvent({ type: "flag.raised", at: h(t0, 55), payload: { dayzId: B, gamertag: "Bravo", texture: "Flag_Bear", poleKey: "BEAR:0:0" } });
    await mkEvent({ type: "flag.raised", at: h(t0, 65), payload: { dayzId: B, gamertag: "Bravo", texture: "Flag_Bear", poleKey: "BEAR:0:0" } });
    await mkEvent({ type: "flag.raised", at: h(t0, 75), payload: { dayzId: B, gamertag: "Bravo", texture: "Flag_Bear", poleKey: "BEAR:0:0" } });
  });

  describe("playerBoards", () => {
    it("all-time: raiders, killers, deaths, K/D, play time and friendly fire", async () => {
      const boards = await playerBoardsDb(db, ALL, undefined, now);
      expect(boards.builders).toEqual([
        { dayzId: A, gamertag: "Alpha", value: 4 },
        { dayzId: R, gamertag: "Romeo", value: 2 },
        { dayzId: N, gamertag: "November", value: 1 },
      ]);

      expect(boards.scope).toEqual(ALL);
      expect(boards.seasons).toEqual([2, 1]);
      expect(boards.raiders).toEqual([{ dayzId: A, gamertag: "Alpha", value: 2 }]);
      // 12 in season 1 + the friendly kill before it; the self-kill is not one.
      expect(boards.killers).toEqual([
        { dayzId: A, gamertag: "Alpha", value: 13 },
        { dayzId: R, gamertag: "Romeo", value: 3 },
      ]);
      expect(boards.playTime).toEqual([{ dayzId: A, gamertag: "Alpha", value: PLAY_ALL }]);
      expect(boards.friendlyFire).toEqual([{ dayzId: A, gamertag: "Alpha", value: 1 }]);
      // R died to A twelve times, A to R three, B to A's friendly kill once.
      // R's self-kill and the two killer-less deaths are not PvP deaths.
      expect(boards.deaths).toEqual([
        { dayzId: R, gamertag: "Romeo", value: 12 },
        { dayzId: A, gamertag: "Alpha", value: 3 },
        { dayzId: B, gamertag: "Bravo", value: 1 },
      ]);
    });

    it("the K/D board holds only players at or above KD_MIN_KILLS, and friendly fire earns nothing on it", async () => {
      const boards = await playerBoardsDb(db, ALL, undefined, now);
      expect(KD_MIN_KILLS).toBe(10);
      // A has 13 PvP kills but one is friendly: 12 / 3. The killers board still says 13.
      expect(boards.kd).toEqual([{ dayzId: A, gamertag: "Alpha", value: 4, kills: 12, deaths: 3 }]);
      expect(boards.killers[0]).toEqual({ dayzId: A, gamertag: "Alpha", value: 13 });
      // R has 3 kills — under the gate, so no K/D row at all.
      expect(boards.kd.map((r) => r.dayzId)).not.toContain(R);
    });

    it("season 2 counts only what happened after t50", async () => {
      const boards = await playerBoardsDb(db, SEASON_2, undefined, now);
      expect(boards.scope).toEqual(SEASON_2);
      expect(boards.killers).toEqual([{ dayzId: R, gamertag: "Romeo", value: 3 }]);
      expect(boards.raiders).toEqual([{ dayzId: A, gamertag: "Alpha", value: 2 }]);
      // Only the far side of the straddling session and of the open one.
      expect(boards.playTime).toEqual([{ dayzId: A, gamertag: "Alpha", value: PLAY_SEASON_2 }]);
      expect(boards.friendlyFire).toEqual([]);
      expect(boards.kd).toEqual([]);
      expect(boards.deaths).toEqual([{ dayzId: A, gamertag: "Alpha", value: 3 }]);
      expect(boards.builders).toEqual([{ dayzId: R, gamertag: "Romeo", value: 2 }, { dayzId: A, gamertag: "Alpha", value: 1 }]);
    });

    it("season 1 counts only what happened inside it", async () => {
      const boards = await playerBoardsDb(db, SEASON_1, undefined, now);
      expect(boards.killers).toEqual([{ dayzId: A, gamertag: "Alpha", value: 12 }]);
      expect(boards.raiders).toEqual([]);
      // Only the near side of the straddling session and of the open one.
      expect(boards.playTime).toEqual([{ dayzId: A, gamertag: "Alpha", value: PLAY_SEASON_1 }]);
      expect(boards.friendlyFire).toEqual([]);
      expect(boards.deaths).toEqual([{ dayzId: R, gamertag: "Romeo", value: 12 }]);
      expect(boards.builders).toEqual([{ dayzId: A, gamertag: "Alpha", value: 3 }, { dayzId: N, gamertag: "November", value: 1 }]);
    });

    it("an unknown season number is an empty window, not every row", async () => {
      const boards = await playerBoardsDb(db, { kind: "season", number: 99 }, undefined, now);
      expect(boards.killers).toEqual([]);
      expect(boards.raiders).toEqual([]);
      expect(boards.playTime).toEqual([]);
      expect(boards.deaths).toEqual([]);
      expect(boards.builders).toEqual([]);
      expect(boards.seasons).toEqual([2, 1]);
    });

    it("honours the limit", async () => {
      const boards = await playerBoardsDb(db, ALL, 1, now);
      expect(boards.killers).toEqual([{ dayzId: A, gamertag: "Alpha", value: 13 }]);
    });
  });

  describe("playerProfile", () => {
    it("all-time: every field", async () => {
      const p = (await playerProfileDb(db, "Alpha", ALL, now))!;
      expect(p).not.toBeNull();
      expect(p.dayzId).toBe(A);
      expect(p.gamertag).toBe("Alpha");
      expect(p.linked).toBe(true);
      expect(p.scope).toEqual(ALL);
      expect(p.seasons).toEqual([2, 1]);
      expect(p.playTimeSeconds).toBe(PLAY_ALL);
      expect(p.sessions).toBe(4);
      expect(p.lastSeenAt).toEqual(aLastSeen);
      expect(p.pvpKills).toBe(13);
      expect(p.pvpDeaths).toBe(3);
      // 13 PvP kills less the friendly one, over 3 deaths — the board's rule.
      expect(p.kd).toBe(4);
      expect(p.killedBy).toEqual([{ gamertag: "Romeo", count: 3 }]);
      expect(p.killed).toEqual([{ gamertag: "Romeo", count: 12 }, { gamertag: "Bravo", count: 1 }]);
      expect(p.friendlyFireKills).toBe(1);
      expect(p.friendlyFireDeaths).toBe(0);
      expect(p.raidCredits).toBe(2);
      expect(p.upkeepRaises).toBe(3);
      expect(p.buildPoints).toBe(4);
      expect(p.clanHistory).toEqual([{ tag: "BEAR", name: "BEAR", joinedAt: h(t0, -2), leftAt: null }]);
    });

    it("season 1: the window narrows every aggregate", async () => {
      const p = (await playerProfileDb(db, "Alpha", SEASON_1, now))!;
      expect(p.pvpKills).toBe(12);
      expect(p.pvpDeaths).toBe(0);
      expect(p.kd).toBe(12);
      expect(p.upkeepRaises).toBe(2);
      expect(p.raidCredits).toBe(0);
      expect(p.playTimeSeconds).toBe(PLAY_SEASON_1);
      expect(p.sessions).toBe(4);
      expect(p.friendlyFireKills).toBe(0);
      expect(p.killed).toEqual([{ gamertag: "Romeo", count: 12 }]);
      expect(p.killedBy).toEqual([]);
    });

    it("matches the gamertag case-insensitively", async () => {
      const p = await playerProfileDb(db, "aLpHa", ALL, now);
      expect(p?.dayzId).toBe(A);
    });

    it("a self-kill is neither a kill nor a PvP death", async () => {
      const p = (await playerProfileDb(db, "Romeo", ALL, now))!;
      expect(p.pvpKills).toBe(3);
      expect(p.pvpDeaths).toBe(12);
      expect(p.killed).toEqual([{ gamertag: "Alpha", count: 3 }]);
      expect(p.killedBy).toEqual([{ gamertag: "Alpha", count: 12 }]);
    });

    it("a friendly-fire death is counted on the victim", async () => {
      const p = (await playerProfileDb(db, "Bravo", ALL, now))!;
      expect(p.friendlyFireDeaths).toBe(1);
      expect(p.friendlyFireKills).toBe(0);
      expect(p.pvpDeaths).toBe(1);
    });

    it("a raise before the player's membership span opens is not an upkeep raise", async () => {
      // A has four Flag_Bear raises; the one at t0-3h predates their span.
      const all = (await playerProfileDb(db, "Alpha", ALL, now))!;
      expect(all.upkeepRaises).toBe(3);
    });

    it("a raise in the gap between two membership spans is not an upkeep raise", async () => {
      // B raised BEAR's colors three times: inside the first span, after they
      // left it, and inside the span they rejoined on. Only two count.
      const p = (await playerProfileDb(db, "Bravo", ALL, now))!;
      expect(p.upkeepRaises).toBe(2);
      expect(p.clanHistory).toEqual([
        { tag: "BEAR", name: "BEAR", joinedAt: h(t0, 70), leftAt: null },
        { tag: "BEAR", name: "BEAR", joinedAt: h(t0, -2), leftAt: h(t0, 60) },
      ]);
    });

    it("an unlinked stranger the log has seen still resolves", async () => {
      const p = (await playerProfileDb(db, "Stranger", ALL, now))!;
      expect(p).not.toBeNull();
      expect(p.linked).toBe(false);
      expect(p.dayzId).toBe(S);
      expect(p.pvpKills).toBe(0);
      expect(p.pvpDeaths).toBe(0);
      expect(p.kd).toBeNull();
      expect(p.clanHistory).toEqual([]);
    });

    it("is null for a name the log has never seen", async () => {
      expect(await playerProfileDb(db, "nobody", ALL, now)).toBeNull();
    });
  });

  describe("clanBoard", () => {
    it("is the boards filtered to the actor's clan's current full roster", async () => {
      const boards = await clanBoardDb(db, "dB", ALL, undefined, now);
      expect(boards).not.toBe("not-linked");
      if (typeof boards === "string") throw new Error(boards);
      // A and B only: R is WOLF, P is pending, N is in no clan.
      expect(boards.killers).toEqual([{ dayzId: A, gamertag: "Alpha", value: 13 }]);
      expect(boards.raiders).toEqual([{ dayzId: A, gamertag: "Alpha", value: 2 }]);
      expect(boards.playTime).toEqual([{ dayzId: A, gamertag: "Alpha", value: PLAY_ALL }]);
      expect(boards.friendlyFire).toEqual([{ dayzId: A, gamertag: "Alpha", value: 1 }]);
      expect(boards.kd).toEqual([{ dayzId: A, gamertag: "Alpha", value: 4, kills: 12, deaths: 3 }]);
      // Roster on the VICTIM: A's deaths to R (WOLF) still count; R's own deaths do not appear.
      expect(boards.deaths).toEqual([
        { dayzId: A, gamertag: "Alpha", value: 3 },
        { dayzId: B, gamertag: "Bravo", value: 1 },
      ]);
      // A and B only, again: R's and N's build steps are not on BEAR's board.
      expect(boards.builders).toEqual([{ dayzId: A, gamertag: "Alpha", value: 4 }]);
      expect(boards.seasons).toEqual([2, 1]);
    });

    it("refuses a pending member, a linked non-member and a stranger", async () => {
      expect(await clanBoardDb(db, "dP", ALL, undefined, now)).toBe("pending");
      expect(await clanBoardDb(db, "dN", ALL, undefined, now)).toBe("not-in-clan");
      expect(await clanBoardDb(db, "dZ", ALL, undefined, now)).toBe("not-linked");
    });
  });

  describe("the 'current' scope", () => {
    it("resolves to the newest season, and reports the resolved scope, never 'current'", async () => {
      const boards = await playerBoardsDb(db, { kind: "current" }, undefined, now);
      expect(boards.scope).toEqual(SEASON_2);
      expect(boards.killers).toEqual([{ dayzId: R, gamertag: "Romeo", value: 3 }]);

      const p = (await playerProfileDb(db, "Alpha", { kind: "current" }, now))!;
      expect(p.scope).toEqual(SEASON_2);
      expect(p.pvpKills).toBe(0);
      expect(p.pvpDeaths).toBe(3);

      const clan = await clanBoardDb(db, "dB", { kind: "current" }, undefined, now);
      if (typeof clan === "string") throw new Error(clan);
      expect(clan.scope).toEqual(SEASON_2);
    });

    it("resolves to all-time when the server has no seasons at all", async () => {
      await db.delete(raids);
      await db.delete(seasons);

      const boards = await playerBoardsDb(db, { kind: "current" }, undefined, now);
      expect(boards.scope).toEqual(ALL);
      expect(boards.seasons).toEqual([]);
      expect(boards.killers).toEqual([
        { dayzId: A, gamertag: "Alpha", value: 13 },
        { dayzId: R, gamertag: "Romeo", value: 3 },
      ]);

      const p = (await playerProfileDb(db, "Alpha", { kind: "current" }, now))!;
      expect(p.scope).toEqual(ALL);
      expect(p.pvpKills).toBe(13);
    });
  });

  describe("scope edges", () => {
    it("per-season raid credits key on raids.season_id, not on the season's timestamps", async () => {
      // ⚠️ Scored in season 2, but lowered at an instant inside season 1's
      // window — the one case where the two rules disagree.
      const [s2] = await db.select({ id: seasons.id }).from(seasons).where(sql`${seasons.number} = 2`);
      await mkRaid({ seasonId: s2!.id, at: h(t0, 5), raider: A });

      expect((await playerBoardsDb(db, SEASON_2, undefined, now)).raiders)
        .toEqual([{ dayzId: A, gamertag: "Alpha", value: 3 }]);
      expect((await playerBoardsDb(db, SEASON_1, undefined, now)).raiders).toEqual([]);
      expect((await playerProfileDb(db, "Alpha", SEASON_2, now))!.raidCredits).toBe(3);
      expect((await playerProfileDb(db, "Alpha", SEASON_1, now))!.raidCredits).toBe(0);
      // All-time has no season id and no upper bound: every raid.
      expect((await playerProfileDb(db, "Alpha", ALL, now))!.raidCredits).toBe(3);
    });

    it("an open season ends at now: a future-dated row is outside it, but still on the all-time boards", async () => {
      // A mis-set `servers.clock_offset_ms` is how this happens in production.
      await mkKill({ at: h(now, 24), victim: A, killer: R, victimFactionId: bearId, killerFactionId: wolfId });

      expect((await playerBoardsDb(db, SEASON_2, undefined, now)).killers)
        .toEqual([{ dayzId: R, gamertag: "Romeo", value: 3 }]);
      expect((await playerProfileDb(db, "Romeo", SEASON_2, now))!.pvpKills).toBe(3);
      expect((await playerProfileDb(db, "Romeo", ALL, now))!.pvpKills).toBe(4);
    });
  });
});
