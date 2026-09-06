import { describe, it, expect, beforeEach } from "vitest";
import {
  createClient, runMigrations, requireTestDatabaseUrl,
  servers, factions, factionMembers, declarations, events, admFiles,
  raids, seasonStandings, warLogEvents, clanNotices,
  type Database,
} from "@factions/db";
import { POINTS_UNRANKED, weekStartOf } from "@factions/domain";
import { sql, eq } from "drizzle-orm";
import { raidTick } from "../src/raid-tick.js";
import { seedFaction, seedSeason } from "./seed.js";

const URL = requireTestDatabaseUrl();
const now = new Date("2026-09-04T12:00:00Z");

describe("raidTick", () => {
  let db: Database;
  let serverId = 0;
  let admFileId = 0;
  let lineIndex = 0;
  let BEAR = 0;
  let WOLF = 0;
  const B1 = "B1-DAYZID-0000000000000000000000000";
  const W1 = "W1-DAYZID-0000000000000000000000000";
  const S1 = "S1-DAYZID-0000000000000000000000000";
  const P1 = "1000.00:100.00:1000.00";
  const P2 = "2000.00:100.00:2000.00";

  beforeEach(async () => {
    db = createClient(URL);
    await runMigrations(db);
    await db.transaction(async (tx) => {
      await tx.execute(sql`set local client_min_messages = warning`);
      await tx.execute(sql`truncate table clan_notices, war_log_events, season_standings, raids, seasons, faction_members, declarations, poles, consumer_cursors, events, adm_files, factions, servers restart identity cascade`);
    });
    const [s] = await db.insert(servers).values({ name: "S", map: "livonia", clockOffsetMs: 0 }).returning();
    serverId = s!.id;
    const [a] = await db.insert(admFiles).values({ serverId, filename: "f.ADM", bootAt: now, linesIngested: 0, complete: true }).returning();
    admFileId = a!.id;
    lineIndex = 0;

    await seedSeason(db, serverId, now);

    const bear = await seedFaction(db, { serverId, tag: "BEAR", texture: "Flag_Bear", poleKey: P1, createdAt: now, activatedAt: now });
    BEAR = bear.id;
    const wolf = await seedFaction(db, { serverId, tag: "WOLF", texture: "Flag_Wolf", poleKey: P2, createdAt: now, activatedAt: now });
    WOLF = wolf.id;

    await db.insert(factionMembers).values([
      { factionId: BEAR, serverId, dayzId: B1, discordId: "dB1", role: "leader", joinedAt: now, status: "full" },
      { factionId: WOLF, serverId, dayzId: W1, discordId: "dW1", role: "leader", joinedAt: now, status: "full" },
    ]);
  });

  const lower = (dayzId: string, gamertag: string, texture: string, poleKey: string, at: Date) =>
    db.insert(events).values({
      serverId, admFileId, lineIndex: lineIndex++, type: "flag.lowered", occurredAt: at,
      payload: { dayzId, gamertag, texture, poleKey, pole: { x: 1, y: 2, z: 3 } },
    });

  const declareSolo = async (poleKey: string, dayzId: string) => {
    const [ev] = await db.insert(events).values({
      serverId, admFileId, lineIndex: lineIndex++, type: "flag.raised", occurredAt: now,
      payload: { dayzId, gamertag: "Solo", texture: "Flag_White", poleKey, pole: { x: 1, y: 2, z: 3 } },
    }).returning();
    await db.insert(declarations).values({
      serverId, poleKey, x: "1.00", y: "2.00", z: "3.00", ownerDayzId: dayzId, evidenceEventId: ev!.id, declaredAt: now,
    });
  };

  it("a non-member lowering an active clan's flag at its declared pole is a raid: row, standings, flag_down, war-log, notices", async () => {
    await lower(W1, "Wolfie", "Flag_Bear", P1, now);
    const r = await raidTick(db);
    expect(r).toMatchObject({ raids: 1, absorbed: 0 });
    const [raid] = await db.select().from(raids);
    expect(raid).toMatchObject({
      victimFactionId: BEAR, raiderFactionId: WOLF, raiderDayzId: W1,
      lowerCount: 1, points: POINTS_UNRANKED, victimRankAtLower: null, rankedCountAtLower: 0,
    });
    expect(raid!.weekStart.toISOString()).toBe(weekStartOf(now).toISOString());
    const [bear] = await db.select({ f: factions.flagDownSince, by: factions.flagDownByDayzId }).from(factions).where(eq(factions.id, BEAR));
    expect(bear).toEqual({ f: now, by: W1 });
    const standings = await db.select().from(seasonStandings).orderBy(seasonStandings.factionId);
    expect(standings.map((s) => [s.factionId, s.points, s.raids, s.timesRaided])).toEqual([[BEAR, 0, 0, 1], [WOLF, POINTS_UNRANKED, 1, 0]]);
    const [log] = await db.select().from(warLogEvents);
    expect(log).toMatchObject({ kind: "raid", payload: { raiderClan: "WOLF", victimClan: "BEAR", gamertag: "Wolfie", solo: false } });
    const notices = await db.select({ target: clanNotices.target, kind: clanNotices.kind, to: clanNotices.discordTargetId }).from(clanNotices);
    expect(notices).toEqual(expect.arrayContaining([
      { target: "channel", kind: "flag_down", to: null },
      { target: "dm", kind: "flag_down", to: "dB1" },
    ]));
  });

  it("a second lower by the same clan inside 24 h is absorbed; a different clan's is a new raid", async () => {
    await lower(W1, "Wolfie", "Flag_Bear", P1, now);
    await lower(W1, "Wolfie", "Flag_Bear", P1, new Date(now.getTime() + 3_600_000));
    await lower(S1, "Solo", "Flag_Bear", P1, new Date(now.getTime() + 7_200_000));
    const r = await raidTick(db);
    expect(r).toMatchObject({ raids: 2, absorbed: 1 });
    const rows = await db.select({ raider: raids.raiderFactionId, count: raids.lowerCount, points: raids.points }).from(raids).orderBy(raids.id);
    expect(rows).toEqual([{ raider: WOLF, count: 2, points: POINTS_UNRANKED }, { raider: null, count: 1, points: 0 }]);
    const [bear] = await db.select({ t: seasonStandings.timesRaided }).from(seasonStandings).where(eq(seasonStandings.factionId, BEAR));
    expect(bear!.t).toBe(2);
  });

  it("points come from the victim's rank at the moment of the lower: N = 10, r = 4 → 167", async () => {
    const season = await db.query.seasons.findFirst({ where: (s, { eq }) => eq(s.serverId, serverId) });
    const points = [1000, 900, 800, 600, 500, 400, 300, 200, 100];
    for (let i = 0; i < points.length; i++) {
      const c = await seedFaction(db, { serverId, tag: `C${i}`, texture: `Flag_C${i}`, poleKey: `c${i}:0:0`, createdAt: now, activatedAt: now });
      await db.insert(seasonStandings).values({ seasonId: season!.id, factionId: c.id, points: points[i]! });
    }
    await db.insert(seasonStandings).values({ seasonId: season!.id, factionId: BEAR, points: 700 });

    await lower(W1, "Wolfie", "Flag_Bear", P1, now);
    await raidTick(db);
    const [raid] = await db.select().from(raids).where(eq(raids.victimFactionId, BEAR));
    expect(raid).toMatchObject({ points: 167, victimRankAtLower: 4, rankedCountAtLower: 10 });
  });

  it("no raid for: a full member's lower (upkeep), a reserved clan, a dormant clan, a solo declaration, an undeclared pole", async () => {
    const P3 = "3000.00:100.00:3000.00";
    const P4 = "4000.00:100.00:4000.00";
    const P5 = "5001.00:100.00:5001.00";
    const P6 = "9999.00:100.00:9999.00";
    await seedFaction(db, { serverId, tag: "RSVD", texture: "Flag_Rsvd", poleKey: P3, status: "reserved", reservedUntil: new Date(now.getTime() + 86_400_000), createdAt: now });
    await seedFaction(db, { serverId, tag: "DRMT", texture: "Flag_Drmt", poleKey: P4, status: "dormant", dormantSince: now, createdAt: now, activatedAt: now });
    await declareSolo(P5, S1);

    await lower(B1, "Bear1", "Flag_Bear", P1, now); // upkeep, not a raid
    await lower(W1, "Wolfie", "Flag_Rsvd", P3, now); // reserved clan: not raidable
    await lower(W1, "Wolfie", "Flag_Drmt", P4, now); // dormant clan: not raidable
    await lower(W1, "Wolfie", "Flag_White", P5, now); // solo declaration: not raidable
    await lower(W1, "Wolfie", "Flag_White", P6, now); // undeclared pole: not raidable

    const r = await raidTick(db);
    expect(r.raids).toBe(0);
    expect(await db.select().from(raids)).toEqual([]);
    const [bear] = await db.select({ f: factions.flagDownSince }).from(factions).where(eq(factions.id, BEAR));
    expect(bear!.f).toBeNull();
  });

  it("a lower with no open season is skipped and reported, and the cursor still advances", async () => {
    await db.execute(sql`delete from seasons where server_id = ${serverId}`);
    await lower(W1, "Wolfie", "Flag_Bear", P1, now);
    const seen: number[] = [];
    const r = await raidTick(db, { onNoSeason: (id) => seen.push(id) });
    expect(r.skippedNoSeason).toBe(1);
    expect(seen).toEqual([serverId]);
    const r2 = await raidTick(db, { onNoSeason: (id) => seen.push(id) });
    expect(r2.scanned).toBe(0);
  });

  it("is idempotent across a crash between the raid insert and the cursor write", async () => {
    await lower(W1, "Wolfie", "Flag_Bear", P1, now);
    await raidTick(db);
    expect(await db.select().from(raids)).toHaveLength(1);
    await db.execute(sql`update consumer_cursors set last_event_id = 0 where consumer_name = 'raid-consumer'`);
    await raidTick(db);
    expect(await db.select().from(raids)).toHaveLength(1);
  });
});
