import { describe, it, expect, beforeEach } from "vitest";
import {
  createClient, runMigrations, requireTestDatabaseUrl,
  servers, events, admFiles, raids, seasons, alphaWeeks, warLogEvents, seasonStandings,
  type Database,
} from "@factions/db";
import { weekStartOf } from "@factions/domain";
import { sql, eq } from "drizzle-orm";
import { weekTick, nextWeek } from "../src/week-tick.js";
import { seedFaction, seedSeason } from "./seed.js";

const URL = requireTestDatabaseUrl();

describe("weekTick", () => {
  let db: Database;
  let serverId = 0;
  let admFileId = 0;
  let lineIndex = 0;
  let seasonId = 0;
  let BEAR = 0;
  let WOLF = 0;
  let LYNX = 0;
  let OWL = 0;

  // Season started Wed 2026-09-02 12:00 UTC — weekStartOf(startedAt) is
  // Monday 2026-08-31.
  const seasonStart = new Date("2026-09-02T12:00:00Z");
  const wed = new Date("2026-09-02T18:00:00Z"); // week of 08-31
  const thu = new Date("2026-09-03T10:00:00Z"); // week of 08-31

  beforeEach(async () => {
    db = createClient(URL);
    await runMigrations(db);
    await db.transaction(async (tx) => {
      await tx.execute(sql`set local client_min_messages = warning`);
      await tx.execute(sql`truncate table clan_notices, war_log_events, defenses, alpha_weeks, season_standings, raids, seasons, faction_events, faction_members, declarations, poles, identity_links, consumer_cursors, events, adm_files, factions, servers restart identity cascade`);
    });
    const [s] = await db.insert(servers).values({ name: "S", map: "livonia", clockOffsetMs: 0 }).returning();
    serverId = s!.id;
    const [a] = await db.insert(admFiles).values({ serverId, filename: "f.ADM", bootAt: seasonStart, linesIngested: 0, complete: true }).returning();
    admFileId = a!.id;
    lineIndex = 0;

    const season = await seedSeason(db, serverId, seasonStart);
    seasonId = season.id;

    const bear = await seedFaction(db, { serverId, tag: "BEAR", texture: "Flag_Bear", poleKey: "1000.00:100.00:1000.00", createdAt: seasonStart, activatedAt: seasonStart });
    BEAR = bear.id;
    const wolf = await seedFaction(db, { serverId, tag: "WOLF", texture: "Flag_Wolf", poleKey: "2000.00:100.00:2000.00", createdAt: seasonStart, activatedAt: seasonStart });
    WOLF = wolf.id;
    const lynx = await seedFaction(db, { serverId, tag: "LYNX", texture: "Flag_Lynx", poleKey: "3000.00:100.00:3000.00", createdAt: seasonStart, activatedAt: seasonStart });
    LYNX = lynx.id;
    const owl = await seedFaction(db, { serverId, tag: "OWL", texture: "Flag_Owl", poleKey: "4000.00:100.00:4000.00", createdAt: seasonStart, activatedAt: seasonStart });
    OWL = owl.id;
  });

  const mkEvent = async (at: Date) => {
    const [ev] = await db.insert(events).values({
      serverId, admFileId, lineIndex: lineIndex++, type: "flag.lowered", occurredAt: at, payload: {},
    }).returning();
    return ev!.id;
  };

  /**
   * Inserts a raid row DIRECTLY (Task 3's concern is the tick that reads
   * `raids`, not the consumer that writes them). Every NOT NULL column is
   * supplied, including a synthetic `events` row per raid for
   * `firstLowerEventId`/`lastLowerEventId`, the same way `seedFaction` seeds
   * one for its founding event.
   */
  const seedRaid = async (a: { raider: number; victim: number; points: number; at: Date }) => {
    const evId = await mkEvent(a.at);
    await db.insert(raids).values({
      seasonId, serverId, victimFactionId: a.victim, raiderDayzId: "X",
      raiderFactionId: a.raider, firstLowerEventId: evId, firstLowerAt: a.at, lastLowerAt: a.at,
      lastLowerEventId: evId, lowerCount: 1, points: a.points, victimRankAtLower: null,
      rankedCountAtLower: 0, weekStart: weekStartOf(a.at),
    });
  };

  it("closes the first week at Monday 00:00 UTC with the top three and queues the line", async () => {
    await seedRaid({ raider: WOLF, victim: BEAR, points: 200, at: wed });
    await seedRaid({ raider: LYNX, victim: BEAR, points: 100, at: thu });

    expect(await weekTick(db, { now: new Date("2026-09-06T23:59:59Z") })).toEqual({ closed: 0, errors: 0 });
    expect(await weekTick(db, { now: new Date("2026-09-07T00:00:00Z") })).toEqual({ closed: 1, errors: 0 });

    expect(await db.select().from(alphaWeeks).orderBy(alphaWeeks.rank)).toMatchObject([
      { weekStart: new Date("2026-08-31T00:00:00Z"), rank: 1, factionId: WOLF, points: 200 },
      { weekStart: new Date("2026-08-31T00:00:00Z"), rank: 2, factionId: LYNX, points: 100 },
    ]);
    const [w] = await db.select().from(warLogEvents);
    expect(w).toMatchObject({
      kind: "week_closed", occurredAt: new Date("2026-09-07T00:00:00Z"),
      payload: { first: "WOLF", second: "LYNX", third: null, p1: 200, p2: 100, p3: null },
    });
    expect((await db.select({ w: seasons.weekClosedThrough }).from(seasons))[0]!.w).toEqual(new Date("2026-08-31T00:00:00Z"));
  });

  it("a second tick at the same instant closes nothing more (restart on the boundary)", async () => {
    await seedRaid({ raider: WOLF, victim: BEAR, points: 200, at: wed });
    await seedRaid({ raider: LYNX, victim: BEAR, points: 100, at: thu });

    const now = new Date("2026-09-07T00:00:00Z");
    expect(await weekTick(db, { now })).toEqual({ closed: 1, errors: 0 });
    expect(await weekTick(db, { now })).toEqual({ closed: 0, errors: 0 });

    expect(await db.select().from(alphaWeeks)).toHaveLength(2);
    expect(await db.select().from(warLogEvents)).toHaveLength(1);
  });

  it("two missed weeks close in order, each with its own line", async () => {
    await seedRaid({ raider: WOLF, victim: BEAR, points: 200, at: wed });                              // week 08-31
    await seedRaid({ raider: OWL, victim: BEAR, points: 150, at: new Date("2026-09-09T12:00:00Z") });   // week 09-07

    expect(await weekTick(db, { now: new Date("2026-09-21T00:00:00Z") })).toEqual({ closed: 3, errors: 0 });  // 08-31, 09-07, 09-14 (empty)

    const lines = await db.select().from(warLogEvents).orderBy(warLogEvents.id);
    expect(lines.map((l) => (l.payload as { first: string | null }).first)).toEqual(["WOLF", "OWL", null]);
    expect(lines.map((l) => l.occurredAt.toISOString())).toEqual([
      "2026-09-07T00:00:00.000Z", "2026-09-14T00:00:00.000Z", "2026-09-21T00:00:00.000Z",
    ]);
  });

  it("a week with no raids still closes and says so", async () => {
    expect(await weekTick(db, { now: new Date("2026-09-07T00:00:00Z") })).toEqual({ closed: 1, errors: 0 });
    expect(await db.select().from(alphaWeeks)).toHaveLength(0);
    const [w] = await db.select().from(warLogEvents);
    expect(w).toMatchObject({ payload: { first: null, second: null, third: null, p1: null, p2: null, p3: null } });
    expect((await db.select({ w: seasons.weekClosedThrough }).from(seasons))[0]!.w).toEqual(new Date("2026-08-31T00:00:00Z"));
  });

  it("a closed season is left alone", async () => {
    await db.update(seasons).set({ endedAt: new Date("2026-09-05T00:00:00Z") }).where(eq(seasons.id, seasonId));
    expect(await weekTick(db, { now: new Date("2026-09-21T00:00:00Z") })).toEqual({ closed: 0, errors: 0 });
    expect(await db.select().from(alphaWeeks)).toHaveLength(0);
  });

  it("ties break by §8.1: times_raided asc then activated_at asc", async () => {
    // WOLF and LYNX both score 200 this week. WOLF and LYNX share the same
    // activated_at (seeded above), so only the times_raided tie-break is
    // exercised: LYNX was raided once this season (times_raided 1), WOLF
    // none (times_raided 0) — WOLF ranks first.
    await seedRaid({ raider: WOLF, victim: BEAR, points: 200, at: wed });
    await seedRaid({ raider: LYNX, victim: OWL, points: 200, at: wed });
    // LYNX was itself raided once this season, bumping its times_raided.
    await seedRaid({ raider: BEAR, victim: LYNX, points: 50, at: wed });
    await db.insert(seasonStandings).values([
      { seasonId, factionId: WOLF, points: 200, raids: 1, timesRaided: 0, defenses: 0 },
      { seasonId, factionId: LYNX, points: 200, raids: 1, timesRaided: 1, defenses: 0 },
    ]);

    expect(await weekTick(db, { now: new Date("2026-09-07T00:00:00Z") })).toEqual({ closed: 1, errors: 0 });

    const [first] = await db.select().from(alphaWeeks).where(eq(alphaWeeks.rank, 1));
    expect(first).toMatchObject({ factionId: WOLF, points: 200 });
  });
});
