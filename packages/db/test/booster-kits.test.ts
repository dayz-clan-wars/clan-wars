import { describe, it, expect, beforeEach } from "vitest";
import {
  createClient, runMigrations, requireTestDatabaseUrl,
  boosterKits, discordBoosters, boosterKitUploads, boosterKitChallenges,
  servers, type Database,
} from "../src/index.js";
import { sql, eq } from "drizzle-orm";

describe("booster kit tables", () => {
  let db: Database;

  beforeEach(async () => {
    db = createClient(requireTestDatabaseUrl());
    await runMigrations(db);
    await db.execute(sql`truncate table booster_kits, discord_boosters, booster_kit_uploads, booster_kit_challenges, servers restart identity cascade`);
  });

  it("stores a kit with no position", async () => {
    await db.insert(boosterKits).values({ discordId: "1", mask: "GasMask" });
    const [row] = await db.select().from(boosterKits);
    expect(row?.posX).toBeNull();
    expect(row?.mask).toBe("GasMask");
  });

  it("stores a placed kit's position as numeric strings", async () => {
    await db.insert(boosterKits).values({
      discordId: "1",
      posX: "7500.25",
      posY: "300.10",
      posZ: "4200.00",
      placedAt: new Date(),
    });
    const [row] = await db.select().from(boosterKits);
    expect(row?.posX).toBe("7500.25");
    expect(row?.posY).toBe("300.10");
    expect(row?.posZ).toBe("4200.00");
  });

  it("holds one booster row per account", async () => {
    const now = new Date();
    await db.insert(discordBoosters).values({ discordId: "1", premiumSince: now, observedAt: now });
    await expect(
      db.insert(discordBoosters).values({ discordId: "1", premiumSince: now, observedAt: now }),
    ).rejects.toThrow();
  });

  it("holds one upload row per server, matching supply_uploads' shape", async () => {
    const [s] = await db.insert(servers).values({
      name: "T", map: "livonia", clockOffsetMs: 0, active: true,
    }).returning();
    const serverId = s!.id;
    await db.insert(boosterKitUploads).values({ serverId, contentHash: "abc", uploadedAt: new Date() });
    await db.insert(boosterKitUploads)
      .values({ serverId, contentHash: "def", uploadedAt: new Date() })
      .onConflictDoUpdate({ target: boosterKitUploads.serverId, set: { contentHash: "def" } });
    const [row] = await db.select().from(boosterKitUploads).where(eq(boosterKitUploads.serverId, serverId));
    expect(row!.contentHash).toBe("def");
  });

  it("allows only one open challenge per account", async () => {
    const now = new Date();
    const later = new Date(now.getTime() + 60_000);
    await db.insert(boosterKitChallenges).values({
      discordId: "1", targetDayzId: "d1", sequence: ["Salute", "Wave"],
      issuedAt: now, expiresAt: later,
    });
    await expect(
      db.insert(boosterKitChallenges).values({
        discordId: "1", targetDayzId: "d1", sequence: ["Salute", "Wave"],
        issuedAt: now, expiresAt: later,
      }),
    ).rejects.toThrow();

    // A closed challenge does not block a new open one.
    await db.update(boosterKitChallenges)
      .set({ closedAt: now })
      .where(eq(boosterKitChallenges.discordId, "1"));
    await db.insert(boosterKitChallenges).values({
      discordId: "1", targetDayzId: "d1", sequence: ["Salute", "Wave"],
      issuedAt: now, expiresAt: later,
    });
  });
});
