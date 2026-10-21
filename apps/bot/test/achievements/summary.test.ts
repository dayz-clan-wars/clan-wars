import { describe, it, expect, beforeEach } from "vitest";
import { createClient, runMigrations, requireTestDatabaseUrl, achievementUnlocks, clanNotices, type Database } from "@factions/db";
import { ACHIEVEMENTS_2026_10 } from "@factions/domain";
import { sql, asc } from "drizzle-orm";
import { queueAchievementSummaries } from "../../src/achievements/summary.js";
import { seedServer, seedLink, TRUNCATE } from "./seed.js";

const URL = requireTestDatabaseUrl();
const A = "A".repeat(36), B = "B".repeat(36), C = "C".repeat(36), D = "D".repeat(36);
const t0 = new Date("2026-10-01T10:00:00Z");
const h = (n: number) => new Date(t0.getTime() + n * 3_600_000);
const RELEASE = h(100);
const SITE = "https://dayzclanwars.com";
const opts = { release: "2026-10" as const, keys: ACHIEVEMENTS_2026_10, before: RELEASE, siteBaseUrl: SITE };

/**
 * The one summary DM per player (spec 2026-10-20-achievements-150, Review Focus 5):
 * the silent backfill credited history, and this tells each linked player how many of
 * the new tiles they already hold — once, by DM, never in a channel.
 */
describe("queueAchievementSummaries", () => {
  let db: Database;
  beforeEach(async () => {
    db = createClient(URL);
    await runMigrations(db);
    await db.transaction(async (tx) => { await tx.execute(sql`set local client_min_messages = warning`); await tx.execute(sql.raw(TRUNCATE)); });
    await seedServer(db);
    await seedLink(db, { dayzId: A, discordId: "111111111111111111", gamertag: "Ann Lee", verifiedAt: t0 });
    await seedLink(db, { dayzId: C, discordId: "333333333333333333", gamertag: "Cat", verifiedAt: t0 });
    await seedLink(db, { dayzId: D, discordId: "444444444444444444", gamertag: "Dan", verifiedAt: t0 });
    await db.insert(achievementUnlocks).values([
      // Ann: three new tiles from history, and one launch tile that is not new.
      { ownerKind: "player", ownerId: A, key: "hipster", earnedAt: h(1), evidence: {} },
      { ownerKind: "player", ownerId: A, key: "gun_mosin", earnedAt: h(2), evidence: {} },
      { ownerKind: "player", ownerId: A, key: "dog_food", earnedAt: h(3), evidence: {} },
      { ownerKind: "player", ownerId: A, key: "first_blood", earnedAt: h(4), evidence: {} },
      // Ben never linked: nobody to DM.
      { ownerKind: "player", ownerId: B, key: "hipster", earnedAt: h(1), evidence: {} },
      // Cat's only new tile was earned live, after the release: the live tick already told her.
      { ownerKind: "player", ownerId: C, key: "hipster", earnedAt: h(101), evidence: {} },
      // Dan holds only launch tiles.
      { ownerKind: "player", ownerId: D, key: "first_blood", earnedAt: h(1), evidence: {} },
    ]);
  });

  it("queues one DM for a linked player with historical new unlocks, and none for the unlinked, the live-only or the launch-only", async () => {
    const r = await queueAchievementSummaries(db, opts);
    expect(r).toEqual({ queued: 1, skipped: 0 });
    const rows = await db.select().from(clanNotices).orderBy(asc(clanNotices.id));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ target: "dm", discordTargetId: "111111111111111111", kind: "achievement_summary", factionId: null, postedAt: null });
    expect(rows[0]!.payload).toEqual({ release: "2026-10", count: 3, gamertag: "Ann Lee", wallUrl: `${SITE}/players/Ann%20Lee#achievements` });
  });

  it("⚠️ run twice, queues nothing new", async () => {
    await queueAchievementSummaries(db, opts);
    const again = await queueAchievementSummaries(db, opts);
    expect(again).toEqual({ queued: 0, skipped: 1 });
    expect(await db.select().from(clanNotices)).toHaveLength(1);
  });

  it("never posts to a channel", async () => {
    await queueAchievementSummaries(db, opts);
    expect((await db.select().from(clanNotices)).every((n) => n.target === "dm")).toBe(true);
  });

  it("a different release is a different summary", async () => {
    await queueAchievementSummaries(db, opts);
    // Not a real release key today; the guard is per release, not per kind.
    const r = await queueAchievementSummaries(db, { ...opts, release: "2027-01" as never });
    expect(r.queued).toBe(1);
  });

  it("dry run counts without writing", async () => {
    const r = await queueAchievementSummaries(db, { ...opts, dryRun: true });
    expect(r).toEqual({ queued: 1, skipped: 0 });
    expect(await db.select().from(clanNotices)).toHaveLength(0);
  });
});
