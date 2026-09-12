import { describe, it, expect, beforeEach } from "vitest";
import { sql } from "drizzle-orm";
import { createClient, runMigrations, requireTestDatabaseUrl, serverRestarts, servers, type Database } from "../src/index.js";

const URL = requireTestDatabaseUrl();

describe("server_restarts", () => {
  let db: Database;
  beforeEach(async () => { db = createClient(URL); await runMigrations(db); await db.execute(sql`truncate table server_restarts`); });

  it("holds one row per server per slot — the primary key is the idempotency guard", async () => {
    const [s] = await db.insert(servers).values({ name: "S", map: "livonia", clockOffsetMs: 0 }).returning();
    const slot = new Date("2026-09-12T14:00:00Z");
    await db.insert(serverRestarts).values({ serverId: s!.id, scheduledFor: slot, issuedAt: new Date(), outcome: "restarted" });
    await expect(db.insert(serverRestarts).values({ serverId: s!.id, scheduledFor: slot, issuedAt: new Date(), outcome: "skipped" })).rejects.toThrow(/server_restarts_pkey|duplicate key/u);
    const again = await db.insert(serverRestarts).values({ serverId: s!.id, scheduledFor: slot, issuedAt: new Date(), outcome: "skipped" }).onConflictDoNothing().returning();
    expect(again).toEqual([]);
  });
  it("refuses an outcome outside the three", async () => {
    const [s] = await db.insert(servers).values({ name: "S2", map: "livonia", clockOffsetMs: 0 }).returning();
    await expect(db.execute(sql`insert into server_restarts (server_id, scheduled_for, issued_at, outcome) values (${s!.id}, now(), now(), 'late')`)).rejects.toThrow(/server_restarts_outcome_valid/u);
  });
});
