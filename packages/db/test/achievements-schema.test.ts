import { describe, it, expect, beforeEach } from "vitest";
import { createClient, runMigrations, requireTestDatabaseUrl, achievementUnlocks, achievementProgress, achievementCounters, type Database } from "../src/index.js";
import { sql } from "drizzle-orm";

const URL = requireTestDatabaseUrl();
const at = new Date("2026-09-01T12:00:00Z");

describe("achievement tables", () => {
  let db: Database;
  beforeEach(async () => {
    db = createClient(URL);
    await runMigrations(db);
    await db.execute(sql`truncate table achievement_unlocks, achievement_progress, achievement_counters restart identity cascade`);
  });

  it("stores one unlock per owner and key; a second insert does nothing", async () => {
    const row = { ownerKind: "player" as const, ownerId: "A".repeat(36), key: "first_blood", earnedAt: at, evidenceId: 7, evidence: { weapon: "M4" } };
    await db.insert(achievementUnlocks).values(row);
    const again = await db.insert(achievementUnlocks).values({ ...row, earnedAt: new Date() }).onConflictDoNothing().returning();
    expect(again).toEqual([]);
    const [u] = await db.select().from(achievementUnlocks);
    expect(u).toMatchObject({ ownerKind: "player", key: "first_blood", earnedAt: at, evidenceId: 7, evidence: { weapon: "M4" } });
    expect(u!.noticedAt).toBeInstanceOf(Date);
  });

  it("refuses coordinates in evidence and an unknown owner kind", async () => {
    await expect(db.insert(achievementUnlocks).values({ ownerKind: "player", ownerId: "A".repeat(36), key: "explorer", earnedAt: at, evidence: { x: 1 } })).rejects.toThrow(/no_coordinates/u);
    await expect(db.insert(achievementUnlocks).values({ ownerKind: "guild" as never, ownerId: "1", key: "alpha", earnedAt: at })).rejects.toThrow(/owner_kind/u);
  });

  it("caches progress and lifetime counters per owner and key", async () => {
    await db.insert(achievementProgress).values({ ownerKind: "clan", ownerId: "3", key: "warpath", count: 4, target: 25, computedAt: at });
    await db.insert(achievementCounters).values({ ownerKind: "player", ownerId: "B".repeat(36), key: "explorer", value: 2, detail: { squares: [1, 2] } });
    expect((await db.select().from(achievementProgress))[0]).toMatchObject({ count: 4, target: 25 });
    expect((await db.select().from(achievementCounters))[0]).toMatchObject({ value: 2, detail: { squares: [1, 2] } });
  });
});
