import { describe, it, expect, beforeEach } from "vitest";
import {
  createClient, runMigrations, requireTestDatabaseUrl,
  servers, factionMembers, events, admFiles,
  raids, seasonStandings,
  type Database,
} from "@factions/db";
import { pointsFor, weekStartOf } from "@factions/domain";
import { sql, eq } from "drizzle-orm";
import { raidTick } from "../src/raid-tick.js";
import { raiseTick } from "../src/raise-tick.js";
import { rankedStandings, weekTopThree, rebuildStandings } from "../src/standings.js";
import { seedFaction, seedSeason } from "./seed.js";

const URL = requireTestDatabaseUrl();
const now = new Date("2026-09-04T12:00:00Z");

describe("standings", () => {
  let db: Database;
  let serverId = 0;
  let admFileId = 0;
  let lineIndex = 0;
  let seasonId = 0;
  let BEAR = 0;
  let WOLF = 0;
  const B1 = "B1-DAYZID-0000000000000000000000000";
  const W1 = "W1-DAYZID-0000000000000000000000000";
  const S1 = "S1-DAYZID-0000000000000000000000000";
  const P1 = "1000.00:100.00:1000.00";
  const P2 = "2000.00:100.00:2000.00";
  const SITE = "https://example.test";

  beforeEach(async () => {
    db = createClient(URL);
    await runMigrations(db);
    await db.transaction(async (tx) => {
      await tx.execute(sql`set local client_min_messages = warning`);
      await tx.execute(sql`truncate table clan_notices, war_log_events, defenses, season_standings, raids, seasons, faction_events, faction_members, declarations, poles, identity_links, consumer_cursors, events, adm_files, factions, servers restart identity cascade`);
    });
    const [s] = await db.insert(servers).values({ name: "S", map: "livonia", clockOffsetMs: 0 }).returning();
    serverId = s!.id;
    const [a] = await db.insert(admFiles).values({ serverId, filename: "f.ADM", bootAt: now, linesIngested: 0, complete: true }).returning();
    admFileId = a!.id;
    lineIndex = 0;

    const season = await seedSeason(db, serverId, now);
    seasonId = season.id;

    const bear = await seedFaction(db, { serverId, tag: "BEAR", texture: "Flag_Bear", poleKey: P1, createdAt: now, activatedAt: now });
    BEAR = bear.id;
    const wolf = await seedFaction(db, { serverId, tag: "WOLF", texture: "Flag_Wolf", poleKey: P2, createdAt: now, activatedAt: now });
    WOLF = wolf.id;

    await db.insert(factionMembers).values([
      { factionId: BEAR, serverId, dayzId: B1, discordId: "dB1", role: "leader", joinedAt: now, status: "full" },
      { factionId: WOLF, serverId, dayzId: W1, discordId: "dW1", role: "leader", joinedAt: now, status: "full" },
    ]);

    // seedFaction wrote its own synthetic flag.raised (SEED). raiseTick acts
    // on flag.raised, so — same as raise-tick.test.ts — advance the
    // raise-consumer cursor past setup so each test starts clean.
    const rows = (await db.execute(sql`select coalesce(max(id), 0)::int as n from events`)) as unknown as { n: number }[];
    await db.execute(sql`insert into consumer_cursors (consumer_name, last_event_id, updated_at) values ('raise-consumer', ${rows[0]!.n}, now())`);
  });

  const lower = (dayzId: string, gamertag: string, texture: string, poleKey: string, at: Date) =>
    db.insert(events).values({
      serverId, admFileId, lineIndex: lineIndex++, type: "flag.lowered", occurredAt: at,
      payload: { dayzId, gamertag, texture, poleKey, pole: { x: 1, y: 2, z: 3 } },
    });

  const raise = (dayzId: string, gamertag: string, texture: string, poleKey: string, at: Date) =>
    db.insert(events).values({
      serverId, admFileId, lineIndex: lineIndex++, type: "flag.raised", occurredAt: at,
      payload: { dayzId, gamertag, texture, poleKey, pole: { x: 1, y: 2, z: 3 } },
    });

  const mkEvent = async () => {
    const [ev] = await db.insert(events).values({
      serverId, admFileId, lineIndex: lineIndex++, type: "flag.lowered", occurredAt: now, payload: {},
    }).returning();
    return ev!.id;
  };

  const mkRaid = async (victimFactionId: number, raiderFactionId: number | null, points: number, weekStart: Date) => {
    const evId = await mkEvent();
    await db.insert(raids).values({
      seasonId, serverId, victimFactionId, raiderDayzId: "X", raiderFactionId,
      firstLowerEventId: evId, firstLowerAt: now, lastLowerAt: now, lastLowerEventId: evId, lowerCount: 1,
      points, victimRankAtLower: null, rankedCountAtLower: 0, weekStart,
    });
  };

  const strip = (r: { id: number } & Record<string, unknown>) => {
    const { id, ...rest } = r;
    return rest;
  };

  it("rankedStandings orders by points desc, times_raided asc, activated_at asc and excludes unranked and dormant", async () => {
    const mk = async (tag: string, activatedAt: Date, status = "active") =>
      seedFaction(db, { serverId, tag, texture: `Flag_${tag}`, poleKey: `${tag}:0:0`, createdAt: now, activatedAt, status, dormantSince: status === "dormant" ? now : null });
    const A = await mk("A", new Date(now.getTime() + 5000));
    const B = await mk("B", new Date(now.getTime() + 4000));
    const C = await mk("C", new Date(now.getTime() + 1000));
    const D = await mk("D", new Date(now.getTime() + 2000));
    const E = await mk("E", new Date(now.getTime() + 3000), "dormant");
    await db.insert(seasonStandings).values([
      { seasonId, factionId: A.id, points: 300, timesRaided: 0 },
      { seasonId, factionId: B.id, points: 300, timesRaided: 2 },
      { seasonId, factionId: C.id, points: 300, timesRaided: 2 },
      { seasonId, factionId: D.id, points: 0, timesRaided: 0 },
      { seasonId, factionId: E.id, points: 100, timesRaided: 0 },
    ]);

    const { ranked, rankOf } = await rankedStandings(db, seasonId);
    expect(ranked.map((r) => r.factionId)).toEqual([A.id, C.id, B.id]);
    expect(rankOf(A.id)).toBe(1);
    expect(rankOf(C.id)).toBe(2);
    expect(rankOf(B.id)).toBe(3);
    expect(rankOf(D.id)).toBeNull();
    expect(rankOf(E.id)).toBeNull();
  });

  it("⚠️ drift: season_standings equals a rebuild from raids + defenses after real raids, an absorbed lower, a solo raid and a defense", async () => {
    await lower(W1, "Wolfie", "Flag_Bear", P1, now); // WOLF raids BEAR
    await lower(W1, "Wolfie", "Flag_Bear", P1, new Date(now.getTime() + 60_000)); // absorbed
    await lower(S1, "Solo", "Flag_Wolf", P2, now); // solo raids WOLF: 0 points, times_raided +1
    await raidTick(db);
    await raise(B1, "Bear1", "Flag_Bear", P1, new Date(now.getTime() + 3_600_000)); // BEAR defends
    await raiseTick(db, { siteBaseUrl: SITE });

    const live = await db.select().from(seasonStandings).orderBy(seasonStandings.factionId);
    await rebuildStandings(db, seasonId);
    const rebuilt = await db.select().from(seasonStandings).orderBy(seasonStandings.factionId);

    expect(rebuilt.map(strip)).toEqual(live.map(strip));
    expect(rebuilt.find((r) => r.factionId === WOLF)).toMatchObject({ points: 100, raids: 1, timesRaided: 1 });
    expect(rebuilt.find((r) => r.factionId === BEAR)).toMatchObject({ points: 0, raids: 0, timesRaided: 1, defenses: 1 });
  });

  it("rebuild repairs a hand-edited row and removes an orphan", async () => {
    await lower(W1, "Wolfie", "Flag_Bear", P1, now);
    await raidTick(db);
    await db.update(seasonStandings).set({ points: 999 }).where(eq(seasonStandings.factionId, BEAR));

    const lynx = await seedFaction(db, { serverId, tag: "LYNX", texture: "Flag_Lynx", poleKey: "9000.00:100.00:9000.00", createdAt: now, activatedAt: now });
    await db.insert(seasonStandings).values({ seasonId, factionId: lynx.id, points: 50 });

    const count = await rebuildStandings(db, seasonId);
    const rows = await db.select().from(seasonStandings);
    expect(count).toBe(rows.length);
    expect(rows.find((r) => r.factionId === BEAR)).toMatchObject({ points: 0, timesRaided: 1 });
    expect(rows.find((r) => r.factionId === lynx.id)).toBeUndefined();
  });

  it("weekTopThree sums stored points per raider clan for the week, ties by §8.1, at most three, only positive", async () => {
    const w = weekStartOf(now);
    const w2 = new Date(w.getTime() + 7 * 86_400_000);
    const mk = async (tag: string) => seedFaction(db, { serverId, tag, texture: `Flag_${tag}`, poleKey: `${tag}z:0:0`, createdAt: now, activatedAt: now });
    const A = await mk("ALFA");
    const B = await mk("BETA");
    const C = await mk("GMMA");
    const D = await mk("DLTA");
    const E = await mk("ECHO");

    // B and C tie at 200 points this week; B's lower times_raided puts it first.
    await db.insert(seasonStandings).values([
      { seasonId, factionId: B.id, timesRaided: 0 },
      { seasonId, factionId: C.id, timesRaided: 1 },
    ]);

    await mkRaid(BEAR, A.id, 300, w);
    await mkRaid(BEAR, B.id, 200, w);
    await mkRaid(BEAR, C.id, 200, w);
    await mkRaid(BEAR, D.id, 50, w); // fourth place: excluded
    await mkRaid(BEAR, E.id, 999, w2); // wrong week: excluded
    await mkRaid(BEAR, null, 0, w); // solo raid: no clan, excluded

    const top = await weekTopThree(db, seasonId, w);
    expect(top.map((t) => t.factionId)).toEqual([A.id, B.id, C.id]);
    expect(top.map((t) => t.points)).toEqual([300, 200, 200]);
  });

  it("raid-tick's rank comes from rankedStandings (N=10, r=4 → 167 still holds)", async () => {
    const points = [1000, 900, 800, 600, 500, 400, 300, 200, 100];
    for (let i = 0; i < points.length; i++) {
      const c = await seedFaction(db, { serverId, tag: `C${i}`, texture: `Flag_C${i}`, poleKey: `c${i}:0:0`, createdAt: now, activatedAt: now });
      await db.insert(seasonStandings).values({ seasonId, factionId: c.id, points: points[i]! });
    }
    await db.insert(seasonStandings).values({ seasonId, factionId: BEAR, points: 700 });

    await lower(W1, "Wolfie", "Flag_Bear", P1, now);
    await raidTick(db);
    const [raid] = await db.select().from(raids).where(eq(raids.victimFactionId, BEAR));
    expect(raid).toMatchObject({ points: 167, victimRankAtLower: 4, rankedCountAtLower: 10 });
    expect(pointsFor(4, 10)).toBe(167);
  });
});
