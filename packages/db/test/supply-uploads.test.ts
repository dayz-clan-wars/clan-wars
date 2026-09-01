import { describe, it, expect, beforeEach } from "vitest";
import { createClient, runMigrations, requireTestDatabaseUrl, supplyUploads, servers, type Database } from "../src/index.js";
import { sql, eq } from "drizzle-orm";

describe("supply_uploads", () => {
  let db: Database;
  let serverId = 0;

  beforeEach(async () => {
    db = createClient(requireTestDatabaseUrl());
    await runMigrations(db);
    await db.execute(sql`truncate table supply_uploads, servers restart identity cascade`);
    const [s] = await db.insert(servers).values({
      name: "T", map: "livonia", clockOffsetMs: 0, active: true,
    }).returning();
    serverId = s!.id;
  });

  it("holds one row per server", async () => {
    await db.insert(supplyUploads).values({ serverId, contentHash: "abc", uploadedAt: new Date() });
    await expect(
      db.insert(supplyUploads).values({ serverId, contentHash: "def", uploadedAt: new Date() }),
    ).rejects.toThrow();
  });

  it("upserts the hash for a server", async () => {
    await db.insert(supplyUploads).values({ serverId, contentHash: "abc", uploadedAt: new Date() });
    await db.insert(supplyUploads)
      .values({ serverId, contentHash: "def", uploadedAt: new Date() })
      .onConflictDoUpdate({ target: supplyUploads.serverId, set: { contentHash: "def" } });
    const [row] = await db.select().from(supplyUploads).where(eq(supplyUploads.serverId, serverId));
    expect(row!.contentHash).toBe("def");
  });
});
