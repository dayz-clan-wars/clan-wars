import { describe, it, expect, beforeEach } from "vitest";
import {
  createClient, runMigrations, requireTestDatabaseUrl,
  servers, factions, players, seasons, seasonStandings, raids, defenses, alphaWeeks, seasonResults, events, admFiles,
  type Database,
} from "@factions/db";
import { sql, eq } from "drizzle-orm";
import { weekStartOf } from "@factions/domain";
import {
  scoreboardDb, alphasDb, seasonsDb, warLogDb,
} from "../src/scoring";
import { directoryDb, clanByTagDb } from "../src/reads";
import { seedFaction, seedSeason } from "./seed";

const URL = requireTestDatabaseUrl();
const now = new Date("2026-09-06T12:00:00Z");
const day = (n: number) => new Date(now.getTime() - n * 86_400_000);
// Monday-aligned weeks, so `weekStartOf(season.startedAt)` (`alphasDb`'s
// enumeration) lands on the same instants these tests assert against.
const week = (n: number) => new Date(weekStartOf(now).getTime() + n * 7 * 86_400_000);

describe("roster scoring reads", () => {
  let db: Database;
  let serverId = 0;
  let admFileId = 0;
  let lineIndex = 0;

  beforeEach(async () => {
    db = createClient(URL);
    await runMigrations(db);
    await db.transaction(async (tx) => {
      await tx.execute(sql`set local client_min_messages = warning`);
      await tx.execute(sql`truncate table clan_notices, war_log_events, season_results, alpha_weeks, defenses, season_standings, raids, seasons, faction_events, faction_members, declarations, poles, identity_links, consumer_cursors, events, adm_files, factions, players, servers restart identity cascade`);
    });
    const [s] = await db.insert(servers).values({ name: "S", map: "livonia", clockOffsetMs: 0, active: true }).returning();
    serverId = s!.id;
    const [a] = await db.insert(admFiles).values({ serverId, filename: "f.ADM", bootAt: now, linesIngested: 0, complete: true }).returning();
    admFileId = a!.id;
    lineIndex = 0;
  });

  const mkEvent = async () => {
    const [ev] = await db.insert(events).values({
      serverId, admFileId, lineIndex: lineIndex++, type: "flag.lowered", occurredAt: now, payload: {},
    }).returning();
    return ev!.id;
  };

  const mkRaid = async (a: { seasonId: number; victim: number; raider: number | null; raiderDayzId?: string; points: number; at: Date }) => {
    const evId = await mkEvent();
    await db.insert(raids).values({
      seasonId: a.seasonId, serverId, victimFactionId: a.victim, raiderDayzId: a.raiderDayzId ?? "X".repeat(20),
      raiderFactionId: a.raider, firstLowerEventId: evId, firstLowerAt: a.at, lastLowerAt: a.at,
      lastLowerEventId: evId, lowerCount: 1, points: a.points, victimRankAtLower: null, rankedCountAtLower: 0,
      weekStart: new Date("2026-08-31T00:00:00Z"),
    });
  };

  const mkDefense = async (a: { seasonId: number; factionId: number; raisedByDayzId?: string; siegeSeconds: number; at: Date }) => {
    const evId = await mkEvent();
    await db.insert(defenses).values({
      factionId: a.factionId, seasonId: a.seasonId, raisedByDayzId: a.raisedByDayzId ?? "Y".repeat(20),
      eventId: evId, flagDownSince: day(1), defendedAt: a.at, siegeSeconds: a.siegeSeconds,
    });
  };

  describe("scoreboard", () => {
    it("orders §8.1 (points desc, times_raided asc, activated_at asc), ranks only active clans with points, excludes disbanded — twin of apps/bot/test/standings.test.ts's \"rankedStandings orders by points desc, times_raided asc, activated_at asc and excludes unranked and dormant\"", async () => {
      const season = await seedSeason(db, serverId, now);
      const mk = async (tag: string, activatedAt: Date, status = "active") =>
        seedFaction(db, { serverId, tag, texture: `Flag_${tag}`, poleKey: `${tag}:0:0`, createdAt: now, activatedAt, status, dormantSince: status === "dormant" ? now : null });
      const A = await mk("A", new Date(now.getTime() + 5000));
      const B = await mk("B", new Date(now.getTime() + 4000));
      const C = await mk("C", new Date(now.getTime() + 1000));
      const D = await mk("D", new Date(now.getTime() + 2000));
      const E = await mk("E", new Date(now.getTime() + 3000), "dormant");
      const F = await mk("F", new Date(now.getTime() + 6000), "disbanded");
      await db.insert(seasonStandings).values([
        { seasonId: season.id, factionId: A.id, points: 300, timesRaided: 0 },
        { seasonId: season.id, factionId: B.id, points: 300, timesRaided: 2 },
        { seasonId: season.id, factionId: C.id, points: 300, timesRaided: 2 },
        { seasonId: season.id, factionId: D.id, points: 0, timesRaided: 0 },
        { seasonId: season.id, factionId: E.id, points: 100, timesRaided: 0 },
        { seasonId: season.id, factionId: F.id, points: 999, timesRaided: 0 },
      ]);

      const { rows } = await scoreboardDb(db);
      expect(rows.map((r) => r.tag)).toEqual(["A", "C", "B", "D", "E"]);
      expect(rows.find((r) => r.tag === "A")!.rank).toBe(1);
      expect(rows.find((r) => r.tag === "C")!.rank).toBe(2);
      expect(rows.find((r) => r.tag === "B")!.rank).toBe(3);
      expect(rows.find((r) => r.tag === "D")!.rank).toBeNull();
      expect(rows.find((r) => r.tag === "E")!.rank).toBeNull();
      expect(rows.map((r) => r.tag)).not.toContain("F");
    });

    it("marks alpha true only for the clan in the latest closed week's alpha_weeks, not an earlier week", async () => {
      const season = await seedSeason(db, serverId, now);
      await db.update(seasons).set({ weekClosedThrough: week(1) }).where(eq(seasons.id, season.id));
      const X = await seedFaction(db, { serverId, tag: "XRAY", texture: "Flag_X", poleKey: "x:0:0", createdAt: now, activatedAt: now });
      const Y = await seedFaction(db, { serverId, tag: "YOKE", texture: "Flag_Y", poleKey: "y:0:0", createdAt: now, activatedAt: now });
      await db.insert(seasonStandings).values([
        { seasonId: season.id, factionId: X.id, points: 100 },
        { seasonId: season.id, factionId: Y.id, points: 100 },
      ]);
      await db.insert(alphaWeeks).values([
        { seasonId: season.id, weekStart: week(0), rank: 1, factionId: X.id, points: 100 },
        { seasonId: season.id, weekStart: week(1), rank: 1, factionId: Y.id, points: 100 },
      ]);

      const { rows } = await scoreboardDb(db);
      expect(rows.find((r) => r.tag === "XRAY")!.alpha).toBe(false);
      expect(rows.find((r) => r.tag === "YOKE")!.alpha).toBe(true);
    });

    it("returns a null season and no rows before season 1 opens", async () => {
      expect(await scoreboardDb(db)).toEqual({ season: null, rows: [] });
    });
  });

  describe("alphas", () => {
    it("lists every closed week newest first, a scoreless week carrying no entries", async () => {
      const season = await seedSeason(db, serverId, now);
      await db.update(seasons).set({ weekClosedThrough: week(1) }).where(eq(seasons.id, season.id));
      const X = await seedFaction(db, { serverId, tag: "XRAY", texture: "Flag_X", poleKey: "x:0:0", createdAt: now, activatedAt: now });
      await db.insert(alphaWeeks).values({ seasonId: season.id, weekStart: week(0), rank: 1, factionId: X.id, points: 100 });
      // week(1) closed with nobody scoring: no alpha_weeks row.

      const { season: s, weeks } = await alphasDb(db);
      expect(s).toEqual({ number: 1 });
      expect(weeks).toHaveLength(2);
      expect(weeks[0]).toMatchObject({ weekStart: week(1), entries: [] });
      expect(weeks[1]).toMatchObject({ weekStart: week(0) });
      expect(weeks[1]!.entries).toEqual([{ rank: 1, tag: "XRAY", name: "XRAY", texture: "Flag_X", points: 100 }]);
    });
  });

  describe("seasons", () => {
    it("lists closed seasons newest first, champion null when nobody scored", async () => {
      const A = await seedFaction(db, { serverId, tag: "AAA", texture: "Flag_A", poleKey: "a:0:0", createdAt: now, activatedAt: now });
      const B = await seedFaction(db, { serverId, tag: "BBB", texture: "Flag_B", poleKey: "b:0:0", createdAt: now, activatedAt: now });

      const [s1] = await db.insert(seasons).values({ serverId, number: 1, startedAt: day(60), endedAt: day(30) }).returning();
      await db.insert(seasonResults).values([
        { seasonId: s1!.id, factionId: A.id, rank: 1, points: 0, raids: 0, timesRaided: 0, defenses: 0, statusAtClose: "active" },
        { seasonId: s1!.id, factionId: B.id, rank: 2, points: 0, raids: 0, timesRaided: 0, defenses: 0, statusAtClose: "active" },
      ]);

      const [s2] = await db.insert(seasons).values({ serverId, number: 2, startedAt: day(29), endedAt: day(1) }).returning();
      await db.insert(seasonResults).values([
        { seasonId: s2!.id, factionId: B.id, rank: 1, points: 500, raids: 3, timesRaided: 1, defenses: 2, statusAtClose: "active" },
        { seasonId: s2!.id, factionId: A.id, rank: 2, points: 100, raids: 1, timesRaided: 0, defenses: 0, statusAtClose: "dormant" },
      ]);

      const list = await seasonsDb(db);
      expect(list.map((s) => s.number)).toEqual([2, 1]);
      expect(list[0]!.champion).toEqual({ tag: "BBB", name: "BBB", texture: "Flag_B", points: 500 });
      expect(list[0]!.rows.map((r) => r.tag)).toEqual(["BBB", "AAA"]);
      expect(list[1]!.champion).toBeNull();
    });
  });

  describe("warLog", () => {
    it("merges raids and defenses newest first, a solo raid has raider null, gamertag comes from players, and limit is honoured", async () => {
      const season = await seedSeason(db, serverId, now);
      const V = await seedFaction(db, { serverId, tag: "VICT", texture: "Flag_V", poleKey: "v:0:0", createdAt: now, activatedAt: now });
      const R = await seedFaction(db, { serverId, tag: "RAID", texture: "Flag_R", poleKey: "r:0:0", createdAt: now, activatedAt: now });
      const RAIDER_ID = "R".repeat(20);
      const SOLO_ID = "S".repeat(20);
      await db.insert(players).values([
        { dayzId: RAIDER_ID, gamertag: "Raidy", firstSeenAt: now, lastSeenAt: now },
        { dayzId: SOLO_ID, gamertag: "Solo", firstSeenAt: now, lastSeenAt: now },
      ]);

      await mkRaid({ seasonId: season.id, victim: V.id, raider: R.id, raiderDayzId: RAIDER_ID, points: 200, at: day(3) });
      await mkRaid({ seasonId: season.id, victim: V.id, raider: null, raiderDayzId: SOLO_ID, points: 0, at: day(2) });
      await mkDefense({ seasonId: season.id, factionId: V.id, siegeSeconds: 3600, at: day(1) });

      const log = await warLogDb(db);
      expect(log.map((e) => e.kind)).toEqual(["defense", "raid", "raid"]);
      const solo = log.find((e) => e.kind === "raid" && e.gamertag === "Solo");
      expect(solo).toMatchObject({ raider: null, victim: { tag: "VICT" }, gamertag: "Solo" });
      const clanned = log.find((e) => e.kind === "raid" && e.gamertag === "Raidy");
      expect(clanned).toMatchObject({ raider: { tag: "RAID" }, gamertag: "Raidy", points: 200 });
      const def = log.find((e) => e.kind === "defense");
      expect(def).toMatchObject({ victim: { tag: "VICT" }, durationSeconds: 3600 });

      const limited = await warLogDb(db, 1);
      expect(limited).toHaveLength(1);
      expect(limited[0]!.kind).toBe("defense");
    });
  });

  describe("directory", () => {
    it("carries the alpha badge", async () => {
      const season = await seedSeason(db, serverId, now);
      await db.update(seasons).set({ weekClosedThrough: week(0) }).where(eq(seasons.id, season.id));
      const X = await seedFaction(db, { serverId, tag: "XRAY", texture: "Flag_X", poleKey: "x:0:0", createdAt: now, activatedAt: now });
      const Y = await seedFaction(db, { serverId, tag: "YOKE", texture: "Flag_Y", poleKey: "y:0:0", createdAt: now, activatedAt: now });
      await db.insert(alphaWeeks).values({ seasonId: season.id, weekStart: week(0), rank: 1, factionId: X.id, points: 100 });

      const { clans } = await directoryDb(db);
      expect(clans.find((c) => c.tag === "XRAY")!.alpha).toBe(true);
      expect(clans.find((c) => c.tag === "YOKE")!.alpha).toBe(false);
    });
  });

  describe("clanByTag", () => {
    it("carries placements, alphaWeeks, longest siege, and daysHeld from the current declaration", async () => {
      const held = await seedFaction(db, { serverId, tag: "HELD", texture: "Flag_Held", poleKey: "held:0:0", createdAt: day(10), activatedAt: day(10) });
      const [s1] = await db.insert(seasons).values({ serverId, number: 1, startedAt: day(60), endedAt: day(30) }).returning();
      const [s2] = await db.insert(seasons).values({ serverId, number: 2, startedAt: day(29), endedAt: day(1) }).returning();
      await db.insert(seasonResults).values([
        { seasonId: s1!.id, factionId: held.id, rank: 2, points: 100, raids: 1, timesRaided: 0, defenses: 0, statusAtClose: "active" },
        { seasonId: s2!.id, factionId: held.id, rank: 1, points: 500, raids: 3, timesRaided: 1, defenses: 2, statusAtClose: "active" },
      ]);
      await db.insert(alphaWeeks).values([
        { seasonId: s1!.id, weekStart: day(45), rank: 1, factionId: held.id, points: 50 },
        { seasonId: s2!.id, weekStart: day(15), rank: 2, factionId: held.id, points: 60 },
      ]);
      const [openSeason] = await db.insert(seasons).values({ serverId, number: 3, startedAt: day(1) }).returning();
      await db.insert(seasonStandings).values({ seasonId: openSeason!.id, factionId: held.id, points: 40, raids: 2, defenses: 1, timesRaided: 3 });
      await mkDefense({ seasonId: openSeason!.id, factionId: held.id, siegeSeconds: 500, at: day(5) });
      await mkDefense({ seasonId: openSeason!.id, factionId: held.id, siegeSeconds: 900, at: day(2) });

      const page = await clanByTagDb(db, "HELD", null, now);
      expect(page!.placements).toEqual([{ season: 2, rank: 1, points: 500 }, { season: 1, rank: 2, points: 100 }]);
      expect(page!.alphaWeeks).toBe(2);
      expect(page!.stats).toEqual({ raids: 2, defenses: 1, longestSiegeSeconds: 900, daysHeld: 10 });

      // A clan with no declaration on file (seeded without one) reports daysHeld null.
      const [freeFaction] = await db.insert(factions).values({
        serverId, name: "FREE", tag: "FREE", texture: "Flag_Free", status: "active", leaderDiscordId: "d1", createdAt: now, activatedAt: now,
      }).returning();
      const freePage = await clanByTagDb(db, "FREE", null, now);
      expect(freePage!.stats.daysHeld).toBeNull();
      expect(freeFaction).toBeDefined();
    });
  });
});
