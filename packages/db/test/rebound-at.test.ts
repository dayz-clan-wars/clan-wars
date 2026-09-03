import { describe, it, expect, beforeEach } from "vitest";
import { createClient, runMigrations, requireTestDatabaseUrl, servers, factions, type Database } from "@factions/db";
import { sql, eq } from "drizzle-orm";

const URL = requireTestDatabaseUrl();
const now = new Date("2026-09-03T12:00:00Z");

describe("factions.rebound_at", () => {
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

  it("⚠️ defaults to null, so no existing faction starts on cooldown", async () => {
    // A DEFAULT now() would put every faction in factions_live on a 7-day
    // rebind cooldown the moment the migration applied, with nothing saying so.
    const [f] = await seed();
    expect(f!.reboundAt).toBeNull();
  });

  it("stores a timestamp", async () => {
    const [f] = await seed();
    await db.update(factions).set({ reboundAt: now }).where(eq(factions.id, f!.id));
    const [row] = await db.select().from(factions).where(eq(factions.id, f!.id));
    expect(row!.reboundAt).toEqual(now);
  });
});
