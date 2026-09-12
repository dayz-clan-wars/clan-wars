import { describe, it, expect, beforeEach } from "vitest";
import { createClient, runMigrations, requireTestDatabaseUrl, servers, identityLinks, players, membershipHistory, achievementUnlocks, achievementProgress, type Database } from "@factions/db";
import { sql } from "drizzle-orm";
import { achievementsForDb } from "../src/achievements";
import { seedFaction } from "./seed";

const URL = requireTestDatabaseUrl();
const A = "A".repeat(40);
const t0 = new Date("2026-08-01T00:00:00Z");
const d = (n: number) => new Date(t0.getTime() + n * 86_400_000);

describe("achievementsForDb", () => {
  let db: Database; let serverId = 0; let bear = 0; let wolf = 0;
  beforeEach(async () => {
    db = createClient(URL);
    await runMigrations(db);
    await db.transaction(async (tx) => {
      await tx.execute(sql`set local client_min_messages = warning`);
      await tx.execute(sql`truncate table achievement_unlocks, achievement_progress, membership_history, declarations, poles, factions, identity_links, players, events, adm_files, servers restart identity cascade`);
    });
    serverId = (await db.insert(servers).values({ name: "S", map: "livonia", clockOffsetMs: 0 }).returning())[0]!.id;
    bear = (await seedFaction(db, { serverId, tag: "BEAR", texture: "Flag_Bear", createdAt: t0 })).id;
    wolf = (await seedFaction(db, { serverId, tag: "WOLF", texture: "Flag_Wolf", poleKey: "9000.00:100.00:9000.00", x: 9000, z: 9000, createdAt: t0 })).id;
    await db.insert(players).values({ dayzId: A, gamertag: "Ann", firstSeenAt: t0, lastSeenAt: t0 });
    await db.insert(identityLinks).values({ discordId: "1", dayzId: A, gamertag: "Ann", verifiedAt: t0 });
  });

  it("a player's wall: all 50 tiles, their own unlocks, progress, and the team unlocks of clans they were in at the time", async () => {
    await db.insert(membershipHistory).values([{ serverId, factionId: bear, dayzId: A, joinedAt: d(0), leftAt: d(10) }, { serverId, factionId: wolf, dayzId: A, joinedAt: d(20), leftAt: null }]);
    await db.insert(achievementUnlocks).values([
      { ownerKind: "player", ownerId: A, key: "first_blood", earnedAt: d(1) },
      { ownerKind: "clan", ownerId: String(bear), key: "first_raid", earnedAt: d(5) },      // in BEAR then: shown
      { ownerKind: "clan", ownerId: String(bear), key: "fortress", earnedAt: d(15) },       // after leaving BEAR: not shown
      { ownerKind: "clan", ownerId: String(wolf), key: "alpha", earnedAt: d(25) },          // in WOLF now: shown
    ]);
    await db.insert(achievementProgress).values([
      { ownerKind: "player", ownerId: A, key: "ten_down", count: 7, target: 10, computedAt: d(30) },
      { ownerKind: "player", ownerId: A, key: "veteran", count: 90, target: 100, computedAt: d(30) },
      { ownerKind: "player", ownerId: A, key: "builder", count: 10, target: 100, computedAt: d(30) },
    ]);
    const wall = (await achievementsForDb(db, { gamertag: "ann" }, d(30)))!;
    expect(wall.tiles).toHaveLength(50);
    expect(wall.earned).toBe(3);
    const by = (k: string) => wall.tiles.find((t) => t.key === k)!;
    expect(by("first_blood")).toMatchObject({ earnedAt: d(1), count: 1, clanTag: null });
    expect(by("first_raid")).toMatchObject({ earnedAt: d(5), clanTag: "BEAR" });
    expect(by("fortress")).toMatchObject({ earnedAt: null });
    expect(by("alpha")).toMatchObject({ earnedAt: d(25), clanTag: "WOLF" });
    expect(by("ten_down")).toMatchObject({ count: 7, target: 10, earnedAt: null });
    expect(wall.closest.map((t) => t.key)).toEqual(["veteran", "ten_down", "builder"]);   // by count/target, desc
  });

  it("a clan's wall: the 12 team tiles only", async () => {
    await db.insert(achievementUnlocks).values({ ownerKind: "clan", ownerId: String(bear), key: "colors_raised", earnedAt: d(1) });
    const wall = (await achievementsForDb(db, { clanTag: "bear" }, d(30)))!;
    expect(wall.tiles).toHaveLength(12);
    expect(wall.tiles.every((t) => t.group === "team")).toBe(true);
    expect(wall.earned).toBe(1);
    expect(wall.closest).toEqual([]);
  });

  it("null for a name the log has never seen", async () => {
    expect(await achievementsForDb(db, { gamertag: "nobody" }, d(30))).toBeNull();
    expect(await achievementsForDb(db, { clanTag: "NOPE" }, d(30))).toBeNull();
  });
});
