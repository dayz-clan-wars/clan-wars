import { describe, it, expect, beforeEach } from "vitest";
import { createClient, runMigrations, requireTestDatabaseUrl, achievementUnlocks, clanNotices, factions, type Database } from "@factions/db";
import { sql, eq, asc } from "drizzle-orm";
import { backfillAchievementNotices } from "../../src/achievements/backfill-notices.js";
import { achievementsTick } from "../../src/achievements/tick.js";
import { seedServer, seedLink, seedKill, seedFaction, seedMembership, TRUNCATE } from "./seed.js";

const URL = requireTestDatabaseUrl();
const A = "A".repeat(36), B = "B".repeat(36);
const t0 = new Date("2026-08-01T10:00:00Z");
const h = (n: number) => new Date(t0.getTime() + n * 3_600_000);
const CH = "123456789012345678";
const CLAN_CH = "999999999999999999";
const pl = (n: { payload: unknown }) => n.payload as Record<string, string | number | boolean | null>;

describe("backfillAchievementNotices", () => {
  let db: Database; let serverId = 0; let bear = 0;
  beforeEach(async () => {
    db = createClient(URL);
    await runMigrations(db);
    await db.transaction(async (tx) => { await tx.execute(sql`set local client_min_messages = warning`); await tx.execute(sql.raw(TRUNCATE)); });
    serverId = (await seedServer(db)).id;
    bear = (await seedFaction(db, { serverId, tag: "BEAR", texture: "Flag_Bear", createdAt: t0, activatedAt: t0 })).id;
    await db.update(factions).set({ discordTextChannelId: CLAN_CH }).where(eq(factions.id, bear));
    await seedLink(db, { dayzId: A, discordId: "111111111111111111", gamertag: "Ann", verifiedAt: t0 });
    await seedMembership(db, { serverId, factionId: bear, dayzId: A, joinedAt: t0, leftAt: null });
    // The silent backfill: unlocks with no notices, earned out of insertion order.
    await db.insert(achievementUnlocks).values([
      { ownerKind: "player", ownerId: A, key: "sniper", earnedAt: h(5), evidence: {} },
      { ownerKind: "player", ownerId: A, key: "enlisted", earnedAt: h(1), evidence: {} },
      { ownerKind: "clan", ownerId: String(bear), key: "colors_raised", earnedAt: h(3), evidence: {} },
      { ownerKind: "player", ownerId: B, key: "first_blood", earnedAt: h(2), evidence: {} },   // never linked: no DM, no clan
    ]);
  });

  it("queues the public wall in earned order, one row per unlock, naming the owner", async () => {
    const r = await backfillAchievementNotices(db, { achievementsChannelId: CH, targets: { public: true, clan: false, dm: false } });
    expect(r).toEqual({ unlocks: 4, queued: 4, skipped: 0, failed: 0 });
    const rows = await db.select().from(clanNotices).orderBy(asc(clanNotices.id));
    expect(rows.map((n) => `${n.target}:${n.discordTargetId}:${pl(n).key}`)).toEqual([`channel:${CH}:enlisted`, `channel:${CH}:first_blood`, `channel:${CH}:colors_raised`, `channel:${CH}:sniper`]);
    expect(rows.map((n) => n.occurredAt)).toEqual([h(1), h(2), h(3), h(5)]);
    expect(rows[3]!.payload).toMatchObject({ ownerKind: "player", ownerId: A, ownerName: "111111111111111111", gamertag: "Ann", clanTag: "BEAR", public: true });
    expect(rows[2]!.payload).toMatchObject({ ownerKind: "clan", clanTag: "BEAR", public: true });
    expect(rows.every((n) => n.postedAt === null)).toBe(true);
  });

  it("is idempotent, and skips what the live tick already announced", async () => {
    // The live tick announces a fresh kill's unlocks (marksman etc.) first.
    await seedKill(db, { serverId, killer: A, victim: B, at: h(6), weapon: "Mosin", distanceM: 200 });
    await achievementsTick(db, { now: h(7), achievementsChannelId: CH });
    const live = (await db.select().from(clanNotices)).length;
    expect(live).toBeGreaterThan(0);
    const first = await backfillAchievementNotices(db, { achievementsChannelId: CH, targets: { public: true, clan: true, dm: true } });
    expect(first.failed).toBe(0);
    expect(first.skipped).toBeGreaterThan(0);          // the tick's own unlocks
    const after = (await db.select().from(clanNotices)).length;
    const again = await backfillAchievementNotices(db, { achievementsChannelId: CH, targets: { public: true, clan: true, dm: true } });
    expect(again).toMatchObject({ queued: 0, failed: 0 });
    expect((await db.select().from(clanNotices)).length).toBe(after);
    // The wall carries each (owner, key) once.
    const wall = (await db.select().from(clanNotices).where(eq(clanNotices.discordTargetId, CH))).map((n) => `${pl(n).ownerId}:${pl(n).key}`);
    expect(new Set(wall).size).toBe(wall.length);
  });

  it("targets pick the surfaces: clan+dm without public writes no wall row; a dry run writes nothing", async () => {
    const dry = await backfillAchievementNotices(db, { achievementsChannelId: CH, targets: { public: true, clan: true, dm: true }, dryRun: true });
    expect(dry).toEqual({ unlocks: 4, queued: 4, skipped: 0, failed: 0 });
    expect(await db.select().from(clanNotices)).toHaveLength(0);
    await backfillAchievementNotices(db, { achievementsChannelId: CH, targets: { public: false, clan: true, dm: true } });
    const rows = await db.select().from(clanNotices).orderBy(asc(clanNotices.id));
    expect(rows.some((n) => n.discordTargetId === CH)).toBe(false);
    // A's two unlocks → clan channel + DM each; the clan's → clan channel only (its member DMs
    // read faction_members, and this seed writes only membership_history); B's → nothing (unlinked, no clan).
    expect(rows.map((n) => `${n.target}:${pl(n).key}`)).toEqual(["channel:enlisted", "dm:enlisted", "channel:colors_raised", "channel:sniper", "dm:sniper"]);
  });
});
