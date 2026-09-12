import { describe, it, expect, beforeEach } from "vitest";
import { createClient, runMigrations, requireTestDatabaseUrl, factions, seasons, type Database } from "@factions/db";
import { sql, eq } from "drizzle-orm";
import { TEAM_RULES } from "../../src/achievements/rules-team.js";
import { seedServer, seedFaction, seedSeason, seedMembership, seedRaid, seedDefense, seedAlphaWeek, seedSeasonResult, TRUNCATE } from "./seed.js";

const URL = requireTestDatabaseUrl();
const A = "A".repeat(36);
const t0 = new Date("2026-08-03T00:00:00Z");   // a Monday
const d = (n: number) => new Date(t0.getTime() + n * 86_400_000);
const rule = (k: string) => TEAM_RULES[k as keyof typeof TEAM_RULES]!;
const ctx = { now: d(400) };

describe("team rules", () => {
  let db: Database; let serverId = 0; let bear = 0; let wolf = 0; let seasonId = 0;
  const clan = () => ({ kind: "clan" as const, id: String(bear) });
  beforeEach(async () => {
    db = createClient(URL);
    await runMigrations(db);
    await db.transaction(async (tx) => { await tx.execute(sql`set local client_min_messages = warning`); await tx.execute(sql.raw(TRUNCATE)); });
    serverId = (await seedServer(db)).id;
    bear = (await seedFaction(db, { serverId, tag: "BEAR", texture: "Flag_Bear", createdAt: d(0), activatedAt: null })).id;
    wolf = (await seedFaction(db, { serverId, tag: "WOLF", texture: "Flag_Wolf", poleKey: "9000.00:100.00:9000.00", x: 9000, z: 9000, createdAt: d(0), activatedAt: d(0) })).id;
    await seedSeason(db, serverId, d(0));
    seasonId = (await db.select({ id: seasons.id }).from(seasons))[0]!.id;
  });

  it("colors_raised: activation, dated to it", async () => {
    expect((await rule("colors_raised")(db, clan(), ctx)).count).toBe(0);
    await db.update(factions).set({ activatedAt: d(1) }).where(eq(factions.id, bear));
    expect(await rule("colors_raised")(db, clan(), ctx)).toMatchObject({ count: 1, earnedAt: d(1), evidence: { tag: "BEAR" } });
  });

  it("full_strength: ten overlapping membership spans, earned when the tenth joined", async () => {
    for (let i = 0; i < 9; i++) await seedMembership(db, { serverId, factionId: bear, dayzId: `${i}`.padStart(36, "M"), joinedAt: d(i), leftAt: null });
    await seedMembership(db, { serverId, factionId: bear, dayzId: "Z".repeat(36), joinedAt: d(1), leftAt: d(2) });   // gone before the tenth
    expect(await rule("full_strength")(db, clan(), ctx)).toMatchObject({ count: 9, target: 10 });
    await seedMembership(db, { serverId, factionId: bear, dayzId: "T".repeat(36), joinedAt: d(12), leftAt: null });
    expect(await rule("full_strength")(db, clan(), ctx)).toMatchObject({ count: 10, earnedAt: d(12) });
  });

  it("first_raid / warpath / giant_killer / wide_net: from the raids the clan made", async () => {
    expect((await rule("first_raid")(db, clan(), ctx)).count).toBe(0);
    const r1 = await seedRaid(db, { serverId, seasonId, victimFactionId: wolf, raiderDayzId: A, raiderFactionId: bear, at: d(1), victimRank: 2 });
    expect(await rule("first_raid")(db, clan(), ctx)).toMatchObject({ count: 1, earnedAt: d(1), evidenceId: r1.id });
    expect((await rule("giant_killer")(db, clan(), ctx)).count).toBe(0);
    await seedRaid(db, { serverId, seasonId, victimFactionId: wolf, raiderDayzId: A, raiderFactionId: bear, at: d(2), victimRank: 1 });
    expect(await rule("giant_killer")(db, clan(), ctx)).toMatchObject({ count: 1, earnedAt: d(2) });
    expect(await rule("warpath")(db, clan(), ctx)).toMatchObject({ count: 2, target: 25 });
    expect(await rule("wide_net")(db, clan(), ctx)).toMatchObject({ count: 1, target: 5 });
    await seedRaid(db, { serverId, seasonId, victimFactionId: bear, raiderDayzId: A, raiderFactionId: wolf, at: d(3) });   // against us: not ours
    expect((await rule("warpath")(db, clan(), ctx)).count).toBe(2);
  });

  it("fortress: ten defenses", async () => {
    for (let i = 0; i < 10; i++) await seedDefense(db, { serverId, factionId: bear, seasonId, raisedByDayzId: A, at: d(i), siegeSeconds: 60 });
    expect(await rule("fortress")(db, clan(), ctx)).toMatchObject({ count: 10, earnedAt: d(9) });
  });

  it("alpha / dynasty: weeks in the top three; dynasty needs four consecutive week starts", async () => {
    await seedAlphaWeek(db, { seasonId, factionId: bear, weekStart: d(0), rank: 2 });
    expect(await rule("alpha")(db, clan(), ctx)).toMatchObject({ count: 1, earnedAt: d(7) });
    await seedAlphaWeek(db, { seasonId, factionId: bear, weekStart: d(7), rank: 1 });
    await seedAlphaWeek(db, { seasonId, factionId: bear, weekStart: d(21), rank: 3 });   // gap at d(14)
    await seedAlphaWeek(db, { seasonId, factionId: bear, weekStart: d(28), rank: 3 });
    await seedAlphaWeek(db, { seasonId, factionId: bear, weekStart: d(35), rank: 3 });
    expect(await rule("dynasty")(db, clan(), ctx)).toMatchObject({ count: 3, target: 4 });
    await seedAlphaWeek(db, { seasonId, factionId: bear, weekStart: d(42), rank: 2 });
    expect(await rule("dynasty")(db, clan(), ctx)).toMatchObject({ count: 4, earnedAt: d(49) });
  });

  it("podium / untouched / champions: from the closed season", async () => {
    await db.update(seasons).set({ endedAt: d(60), championFactionId: bear }).where(eq(seasons.id, seasonId));
    await db.update(factions).set({ activatedAt: d(0) }).where(eq(factions.id, bear));
    expect((await rule("podium")(db, clan(), ctx)).count).toBe(0);
    await seedSeasonResult(db, { seasonId, factionId: bear, rank: 1, timesRaided: 0 });
    expect(await rule("podium")(db, clan(), ctx)).toMatchObject({ count: 1, earnedAt: d(60), evidence: { rank: 1, season: 1 } });
    expect(await rule("untouched")(db, clan(), ctx)).toMatchObject({ count: 1, earnedAt: d(60) });
    expect(await rule("champions")(db, clan(), ctx)).toMatchObject({ count: 1, earnedAt: d(60) });
  });

  it("untouched needs the whole season: a clan activated mid-season does not qualify", async () => {
    await db.update(seasons).set({ endedAt: d(60) }).where(eq(seasons.id, seasonId));
    await db.update(factions).set({ activatedAt: d(10) }).where(eq(factions.id, bear));
    await seedSeasonResult(db, { seasonId, factionId: bear, rank: 4, timesRaided: 0 });
    expect((await rule("untouched")(db, clan(), ctx)).count).toBe(0);
  });
});
