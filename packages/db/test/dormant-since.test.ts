import { describe, it, expect, beforeEach } from "vitest";
import { createClient, runMigrations, requireTestDatabaseUrl, servers, factions, type Database } from "@factions/db";
import { sql, eq } from "drizzle-orm";

const URL = requireTestDatabaseUrl();
const now = new Date("2026-09-02T12:00:00Z");

describe("factions.dormant_since", () => {
  let db: Database;
  let serverId = 0;

  beforeEach(async () => {
    db = createClient(URL);
    await runMigrations(db);
    await db.transaction(async (tx) => {
      await tx.execute(sql`set local client_min_messages = warning`);
      await tx.execute(sql`truncate table factions, servers restart identity cascade`);
    });
    const [s] = await db.insert(servers).values({ name: "S", map: "livonia", clockOffsetMs: 0 }).returning();
    serverId = s!.id;
  });

  const seed = () => db.insert(factions).values({
    serverId, name: "Bears", tag: "BEAR", texture: "Flag_Bear",
    poleKey: "1:2:3", x: "1", y: "2", z: "3", status: "active",
    leaderDiscordId: "d1", createdAt: now,
  }).returning();

  it("defaults to null, because only a dormant faction has one", async () => {
    const [f] = await seed();
    expect(f!.dormantSince).toBeNull();
  });

  it("stores and clears a timestamp", async () => {
    const [f] = await seed();
    await db.update(factions).set({ status: "dormant", dormantSince: now }).where(eq(factions.id, f!.id));
    const [dormant] = await db.select().from(factions).where(eq(factions.id, f!.id));
    expect(dormant!.dormantSince).toEqual(now);

    await db.update(factions).set({ status: "active", dormantSince: null }).where(eq(factions.id, f!.id));
    const [revived] = await db.select().from(factions).where(eq(factions.id, f!.id));
    expect(revived!.dormantSince).toBeNull();
  });
});
