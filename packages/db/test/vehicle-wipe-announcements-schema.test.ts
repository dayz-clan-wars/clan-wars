import { describe, it, expect, beforeEach } from "vitest";
import { sql } from "drizzle-orm";
import { createClient, runMigrations, requireTestDatabaseUrl, vehicleWipeAnnouncements, type Database } from "../src/index.js";

const URL = requireTestDatabaseUrl();

describe("vehicle_wipe_announcements", () => {
  let db: Database;
  beforeEach(async () => { db = createClient(URL); await runMigrations(db); await db.execute(sql`truncate table vehicle_wipe_announcements`); });

  it("holds one row per wipe slot — the primary key is the idempotency guard", async () => {
    const wipeAt = new Date("2026-09-14T00:00:00Z");
    await db.insert(vehicleWipeAnnouncements).values({ wipeAt, announcedAt: new Date(), eventName: "cars", outcome: "posted" });
    await expect(db.insert(vehicleWipeAnnouncements).values({ wipeAt, announcedAt: new Date(), eventName: "cars", outcome: "missed" })).rejects.toThrow(/vehicle_wipe_announcements_pkey|duplicate key/u);
    const again = await db.insert(vehicleWipeAnnouncements).values({ wipeAt, announcedAt: new Date(), eventName: "cars", outcome: "missed" }).onConflictDoNothing().returning();
    expect(again).toEqual([]);
  });

  it("refuses an outcome outside ('posted','missed')", async () => {
    await expect(db.execute(sql`insert into vehicle_wipe_announcements (wipe_at, announced_at, event_name, outcome) values (now(), now(), 'cars', 'late')`)).rejects.toThrow(/vehicle_wipe_announcements_outcome_valid/u);
  });

  // ⚠️ Fails if a `server_id` column is ever added — the design decision is that this
  // table is keyed on the calendar alone, not per-server. See schema.ts's comment.
  it("has exactly the four expected columns — no server_id", async () => {
    const rows = await db.execute(sql`select column_name from information_schema.columns where table_name = 'vehicle_wipe_announcements'`);
    const columns = (rows as unknown as { column_name: string }[]).map((r) => r.column_name).sort();
    expect(columns).toEqual(["announced_at", "event_name", "outcome", "wipe_at"].sort());
  });
});
