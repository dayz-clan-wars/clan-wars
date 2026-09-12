import { describe, it, expect, beforeEach } from "vitest";
import { createClient, runMigrations, requireTestDatabaseUrl, achievementCounters, type Database } from "@factions/db";
import { sql } from "drizzle-orm";
import { applyPinCounters, applyPositionCounters, gridSquare } from "../../src/achievements/counters.js";

const URL = requireTestDatabaseUrl();
const A = "A".repeat(36);
const t = (n: number) => new Date(1_756_000_000_000 + n * 60_000);

describe("achievement counters", () => {
  let db: Database;
  beforeEach(async () => {
    db = createClient(URL);
    await runMigrations(db);
    await db.execute(sql`truncate table achievement_counters`);
  });

  it("gridSquare indexes 1 km squares and is not a coordinate", () => {
    expect(gridSquare(5050, 7020)).toBe(5 * 1000 + 7);
    expect(gridSquare(5999.9, 7000)).toBe(gridSquare(5000, 7999));
  });

  it("explorer: the visited-square set grows across passes, records when it crossed 50, and never stores x/z", async () => {
    const rows = Array.from({ length: 49 }, (_, i) => ({ dayzId: A, x: i * 1000 + 1, z: 500, at: t(i) }));
    await db.transaction((tx) => applyPositionCounters(tx, rows));
    let [c] = await db.select().from(achievementCounters);
    expect(c).toMatchObject({ key: "explorer", value: 49 });
    expect(c!.detail.crossedAt).toBeUndefined();
    await db.transaction((tx) => applyPositionCounters(tx, [{ dayzId: A, x: 1, z: 500, at: t(100) }, { dayzId: A, x: 1, z: 1500, at: t(101) }]));
    [c] = await db.select().from(achievementCounters);
    expect(c).toMatchObject({ value: 50, detail: expect.objectContaining({ crossedAt: t(101).toISOString() }) });
    expect(JSON.stringify(c!.detail)).not.toMatch(/"x"|"z"/u);
  });

  it("cartographer: pins dropped, counted for life, crossing recorded", async () => {
    await db.transaction((tx) => applyPinCounters(tx, Array.from({ length: 9 }, (_, i) => ({ dayzId: A, at: t(i) }))));
    await db.transaction((tx) => applyPinCounters(tx, [{ dayzId: A, at: t(20) }]));
    const [c] = await db.select().from(achievementCounters);
    expect(c).toMatchObject({ key: "cartographer", value: 10, detail: { crossedAt: t(20).toISOString() } });
  });
});
