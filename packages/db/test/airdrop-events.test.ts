import { describe, it, expect, beforeEach } from "vitest";
import { createClient, runMigrations, requireTestDatabaseUrl, airdropEvents, servers, type Database } from "../src/index";
import { sql } from "drizzle-orm";

const URL = requireTestDatabaseUrl();

describe("airdrop_events", () => {
  let db: Database; let serverId = 0;
  beforeEach(async () => {
    db = createClient(URL);
    await runMigrations(db);
    await db.execute(sql`truncate table airdrop_events, servers restart identity cascade`);
    const [s] = await db.insert(servers).values({ name: "A", map: "livonia", clockOffsetMs: 0, active: true }).returning();
    serverId = s!.id;
  });

  const row = (over: Record<string, unknown> = {}) => ({
    serverId, slotAt: new Date("2026-09-21T20:00:00Z"), location: "dolnik", colour: "blue",
    decidedAt: new Date("2026-09-21T19:30:00Z"), popAtDecision: 6, threshold: "5", state: "announced" as const, ...over,
  });

  it("holds one row per server per slot", async () => {
    await db.insert(airdropEvents).values(row());
    await expect(db.insert(airdropEvents).values(row({ location: "lukow" }))).rejects.toThrow();
  });

  it("refuses a state outside the four", async () => {
    await expect(db.insert(airdropEvents).values(row({ state: "pending" }))).rejects.toThrow();
  });

  it("refuses a colour outside the three", async () => {
    await expect(db.insert(airdropEvents).values(row({ colour: "green" }))).rejects.toThrow();
  });

  it("defaults to a non-manual drop", async () => {
    await db.insert(airdropEvents).values(row());
    expect((await db.select().from(airdropEvents))[0]!.manual).toBe(false);
  });
});
