import { describe, it, expect, beforeEach, vi } from "vitest";
import { createClient, runMigrations, requireTestDatabaseUrl, achievementUnlocks, factions, seasons, type Database } from "@factions/db";
import { FIREARMS } from "@factions/domain";
import { sql, eq } from "drizzle-orm";
import { TEAM_RULES } from "../../src/achievements/rules-team.js";
import { makeCtx } from "../../src/achievements/types.js";
import { seedServer, seedFaction, seedSeason, seedMembership, seedRaid, seedDefense, seedAlphaWeek, seedSeasonResult, seedKill, seedEvent, TRUNCATE } from "./seed.js";

const URL = requireTestDatabaseUrl();
const A = "A".repeat(36);
const t0 = new Date("2026-08-03T00:00:00Z");   // a Monday
const d = (n: number) => new Date(t0.getTime() + n * 86_400_000);
const rule = (k: string) => TEAM_RULES[k as keyof typeof TEAM_RULES]!;
const NOW = d(400);
const mk = () => makeCtx(NOW);

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
    expect((await rule("colors_raised")(db, clan(), mk())).count).toBe(0);
    await db.update(factions).set({ activatedAt: d(1) }).where(eq(factions.id, bear));
    expect(await rule("colors_raised")(db, clan(), mk())).toMatchObject({ count: 1, earnedAt: d(1), evidence: { tag: "BEAR" } });
  });

  it("full_strength: ten overlapping membership spans, earned when the tenth joined", async () => {
    for (let i = 0; i < 9; i++) await seedMembership(db, { serverId, factionId: bear, dayzId: `${i}`.padStart(36, "M"), joinedAt: d(i), leftAt: null });
    await seedMembership(db, { serverId, factionId: bear, dayzId: "Z".repeat(36), joinedAt: d(1), leftAt: d(2) });   // gone before the tenth
    expect(await rule("full_strength")(db, clan(), mk())).toMatchObject({ count: 9, target: 10 });
    await seedMembership(db, { serverId, factionId: bear, dayzId: "T".repeat(36), joinedAt: d(12), leftAt: null });
    expect(await rule("full_strength")(db, clan(), mk())).toMatchObject({ count: 10, earnedAt: d(12) });
  });

  it("first_raid / warpath / giant_killer / wide_net: from the raids the clan made", async () => {
    expect((await rule("first_raid")(db, clan(), mk())).count).toBe(0);
    const r1 = await seedRaid(db, { serverId, seasonId, victimFactionId: wolf, raiderDayzId: A, raiderFactionId: bear, at: d(1), victimRank: 2 });
    expect(await rule("first_raid")(db, clan(), mk())).toMatchObject({ count: 1, earnedAt: d(1), evidenceId: r1.id });
    expect((await rule("giant_killer")(db, clan(), mk())).count).toBe(0);
    await seedRaid(db, { serverId, seasonId, victimFactionId: wolf, raiderDayzId: A, raiderFactionId: bear, at: d(2), victimRank: 1 });
    expect(await rule("giant_killer")(db, clan(), mk())).toMatchObject({ count: 1, earnedAt: d(2) });
    expect(await rule("warpath")(db, clan(), mk())).toMatchObject({ count: 2, target: 25 });
    expect(await rule("wide_net")(db, clan(), mk())).toMatchObject({ count: 1, target: 5 });
    await seedRaid(db, { serverId, seasonId, victimFactionId: bear, raiderDayzId: A, raiderFactionId: wolf, at: d(3) });   // against us: not ours
    expect((await rule("warpath")(db, clan(), mk())).count).toBe(2);
  });

  it("fortress: ten defenses", async () => {
    for (let i = 0; i < 10; i++) await seedDefense(db, { serverId, factionId: bear, seasonId, raisedByDayzId: A, at: d(i), siegeSeconds: 60 });
    expect(await rule("fortress")(db, clan(), mk())).toMatchObject({ count: 10, earnedAt: d(9) });
  });

  it("alpha / dynasty: weeks in the top three; dynasty needs four consecutive week starts", async () => {
    await seedAlphaWeek(db, { seasonId, factionId: bear, weekStart: d(0), rank: 2 });
    expect(await rule("alpha")(db, clan(), mk())).toMatchObject({ count: 1, earnedAt: d(7) });
    await seedAlphaWeek(db, { seasonId, factionId: bear, weekStart: d(7), rank: 1 });
    await seedAlphaWeek(db, { seasonId, factionId: bear, weekStart: d(21), rank: 3 });   // gap at d(14)
    await seedAlphaWeek(db, { seasonId, factionId: bear, weekStart: d(28), rank: 3 });
    await seedAlphaWeek(db, { seasonId, factionId: bear, weekStart: d(35), rank: 3 });
    expect(await rule("dynasty")(db, clan(), mk())).toMatchObject({ count: 3, target: 4 });
    await seedAlphaWeek(db, { seasonId, factionId: bear, weekStart: d(42), rank: 2 });
    expect(await rule("dynasty")(db, clan(), mk())).toMatchObject({ count: 4, earnedAt: d(49) });
  });

  it("podium / untouched / champions: from the closed season", async () => {
    await db.update(seasons).set({ endedAt: d(60), championFactionId: bear }).where(eq(seasons.id, seasonId));
    await db.update(factions).set({ activatedAt: d(0) }).where(eq(factions.id, bear));
    expect((await rule("podium")(db, clan(), mk())).count).toBe(0);
    await seedSeasonResult(db, { seasonId, factionId: bear, rank: 1, timesRaided: 0 });
    expect(await rule("podium")(db, clan(), mk())).toMatchObject({ count: 1, earnedAt: d(60), evidence: { rank: 1, season: 1 } });
    expect(await rule("untouched")(db, clan(), mk())).toMatchObject({ count: 1, earnedAt: d(60) });
    expect(await rule("champions")(db, clan(), mk())).toMatchObject({ count: 1, earnedAt: d(60) });
  });

  it("untouched needs the whole season: a clan activated mid-season does not qualify", async () => {
    await db.update(seasons).set({ endedAt: d(60) }).where(eq(seasons.id, seasonId));
    await db.update(factions).set({ activatedAt: d(10) }).where(eq(factions.id, bear));
    await seedSeasonResult(db, { seasonId, factionId: bear, rank: 4, timesRaided: 0 });
    expect((await rule("untouched")(db, clan(), mk())).count).toBe(0);
  });
  // ── The four clan tiles (spec 2026-10-20-achievements-150, Task B8) ─────────
  describe("clan tiles", () => {
    const P = (i: number) => `${i}`.padStart(36, "P");
    const V = "V".repeat(36);
    const h = (n: number) => new Date(t0.getTime() + n * 3_600_000);

    it("clan_warband: 250 scoring kills credited to the clan; friendly fire, the Hub, self-kills and another clan's kills count for nothing", async () => {
      // ⚠️ The same three exclusions as `pvpBy` in rules-pvp.ts: friendly fire, the Hub, a self-kill.
      await seedKill(db, { serverId, killer: P(1), victim: V, at: h(0), killerFactionId: bear, friendlyFire: true });
      await seedKill(db, { serverId, killer: P(1), victim: V, at: h(0), killerFactionId: bear, atHub: true });
      await seedKill(db, { serverId, killer: P(1), victim: P(1), at: h(0), killerFactionId: bear });
      await seedKill(db, { serverId, killer: P(2), victim: V, at: h(0), killerFactionId: wolf });
      await seedKill(db, { serverId, killer: P(3), victim: V, at: h(0), killerFactionId: null });
      for (let i = 0; i < 249; i++) await seedKill(db, { serverId, killer: P(i % 7), victim: V, at: h(1 + i), killerFactionId: bear });
      expect(await rule("clan_warband")(db, clan(), mk())).toEqual({ count: 249, target: 250 });
      const last = await seedKill(db, { serverId, killer: P(9), victim: V, at: h(300), killerFactionId: bear });
      expect(await rule("clan_warband")(db, clan(), mk())).toMatchObject({ count: 250, target: 250, earnedAt: h(300), evidenceId: last.id, serverId });
    });

    it("clan_armory: 25 different firearms across the members; repeats, unmapped names, friendly fire and the Hub add nothing", async () => {
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      try {
        const guns = FIREARMS.slice(0, 25).map((f) => f.displayNames[0]!);
        for (let i = 0; i < 24; i++) await seedKill(db, { serverId, killer: P(i % 3), victim: V, at: h(i), weapon: guns[i], distanceM: 30, killerFactionId: bear });
        await seedKill(db, { serverId, killer: P(0), victim: V, at: h(30), weapon: guns[0], distanceM: 30, killerFactionId: bear });           // a repeat
        await seedKill(db, { serverId, killer: P(0), victim: V, at: h(31), weapon: "Zap Gun 3000", distanceM: 30, killerFactionId: bear });   // nobody mapped it
        await seedKill(db, { serverId, killer: P(0), victim: V, at: h(32), weapon: guns[24], distanceM: 30, killerFactionId: bear, friendlyFire: true });
        await seedKill(db, { serverId, killer: P(0), victim: V, at: h(33), weapon: guns[24], distanceM: 30, killerFactionId: bear, atHub: true });
        await seedKill(db, { serverId, killer: P(5), victim: V, at: h(34), weapon: guns[24], distanceM: 30, killerFactionId: wolf });
        expect(await rule("clan_armory")(db, clan(), mk())).toEqual({ count: 24, target: 25 });
        const k = await seedKill(db, { serverId, killer: P(4), victim: V, at: h(40), weapon: guns[24], distanceM: 30, killerFactionId: bear });
        expect(await rule("clan_armory")(db, clan(), mk())).toMatchObject({ count: 25, earnedAt: h(40), evidenceId: k.id, evidence: { firearms: 25 } });
        // Warned at most once for the process (the shared lookup), never per clan or per pass.
        expect(warn.mock.calls.filter((c) => String(c[0]).includes("Zap Gun 3000")).length).toBeLessThanOrEqual(1);
      } finally { warn.mockRestore(); }
    });

    it("clan_renovators: 50 ruin repairs by players while full members; before joining, after leaving, builds and outsiders count for nothing", async () => {
      const A2 = P(1), B2 = P(2), OUT = P(3);
      await seedMembership(db, { serverId, factionId: bear, dayzId: A2, joinedAt: h(10), leftAt: null });
      await seedMembership(db, { serverId, factionId: bear, dayzId: B2, joinedAt: h(10), leftAt: h(20) });
      const repair = (dayzId: string, at: Date) => seedEvent(db, { serverId, type: "base.built", at, payload: { dayzId, structure: null, part: "door" } });
      await repair(A2, h(5));      // before A joined
      await repair(B2, h(25));     // after B left
      await repair(OUT, h(15));    // never a member
      await seedEvent(db, { serverId, type: "base.built", at: h(15), payload: { dayzId: A2, structure: "Fence", part: "wall_base_down" } });   // a build, not a repair
      for (let i = 0; i < 5; i++) await repair(B2, h(11 + i));
      for (let i = 0; i < 44; i++) await repair(A2, h(30 + i));
      expect(await rule("clan_renovators")(db, clan(), mk())).toEqual({ count: 49, target: 50 });
      const e = await repair(A2, h(100));
      expect(await rule("clan_renovators")(db, clan(), mk())).toMatchObject({ count: 50, earnedAt: h(100), evidenceId: e.id, serverId });
    });

    it("clan_arsenal: each gun class earned by a member while in the clan; earned at the sixth; a tile earned before joining does not count", async () => {
      const A2 = P(1), B2 = P(2), C2 = P(3), D2 = P(4);
      await seedMembership(db, { serverId, factionId: bear, dayzId: A2, joinedAt: d(10), leftAt: null });
      await seedMembership(db, { serverId, factionId: bear, dayzId: B2, joinedAt: d(20), leftAt: null });
      await seedMembership(db, { serverId, factionId: bear, dayzId: C2, joinedAt: d(10), leftAt: d(15) });
      await seedMembership(db, { serverId, factionId: wolf, dayzId: D2, joinedAt: d(0), leftAt: null });
      const unlock = (ownerId: string, key: string, earnedAt: Date) => db.insert(achievementUnlocks).values({ ownerKind: "player", ownerId, key, earnedAt });
      await unlock(A2, "class_pistols", d(11));
      await unlock(A2, "class_smgs", d(12));
      await unlock(C2, "class_shotguns", d(14));          // while C was in
      await unlock(C2, "class_rifles", d(16));            // after C left
      await unlock(B2, "class_snipers", d(5));            // ⚠️ before B joined: does not count
      await unlock(B2, "class_assault_rifles", d(21));
      await unlock(D2, "class_rifles", d(3));             // another clan's member
      await unlock(A2, "full_armory", d(13));             // not a class tile
      expect(await rule("clan_arsenal")(db, clan(), mk())).toEqual({ count: 4, target: 6 });
      await unlock(B2, "class_rifles", d(22));
      expect(await rule("clan_arsenal")(db, clan(), mk())).toEqual({ count: 5, target: 6 });
      await unlock(A2, "class_snipers", d(30));
      expect(await rule("clan_arsenal")(db, clan(), mk())).toMatchObject({ count: 6, target: 6, earnedAt: d(30), evidence: { classes: 6 } });
    });
  });
});
