import { describe, it, expect, beforeEach } from "vitest";
import {
  createClient, runMigrations, requireTestDatabaseUrl,
  awardGrants, awardUploads, boosterKitChallenges, servers, type Database,
} from "../src/index.js";
import { sql, eq } from "drizzle-orm";

describe("award tables", () => {
  let db: Database;
  const now = new Date("2026-09-22T12:00:00Z");

  beforeEach(async () => {
    db = createClient(requireTestDatabaseUrl());
    await runMigrations(db);
    await db.execute(sql`truncate table award_grants, award_uploads, booster_kit_challenges, servers restart identity cascade`);
  });

  const grant = () => db.insert(awardGrants).values({
    awardKey: "plate-carrier", discordId: "1", grantedByDiscordId: "9", reason: "Won",
    grantedAt: now, placeBy: new Date("2026-09-29T12:00:00Z"),
  }).returning();

  it("defaults picks to an empty object and leaves the clock null", async () => {
    const [g] = await grant();
    expect(g!.picks).toEqual({});
    expect(g!.liveFrom).toBeNull();
    expect(g!.expiresAt).toBeNull();
    expect(g!.revokedAt).toBeNull();
  });

  it("a kit challenge has no grant; an award challenge names one, and dies with it", async () => {
    const [g] = await grant();
    await db.insert(boosterKitChallenges).values({
      discordId: "1", targetDayzId: "A".repeat(40), sequence: ["EmoteSalute"],
      issuedAt: now, expiresAt: now, awardGrantId: g!.id,
    });
    await db.delete(awardGrants).where(eq(awardGrants.id, g!.id));
    expect(await db.select().from(boosterKitChallenges)).toEqual([]);
  });

  it("⚠️ still allows only one open challenge per account, kit or award", async () => {
    const [g] = await grant();
    const row = { discordId: "1", targetDayzId: "A".repeat(40), sequence: ["EmoteSalute"], issuedAt: now, expiresAt: now };
    await db.insert(boosterKitChallenges).values(row);
    await expect(db.insert(boosterKitChallenges).values({ ...row, awardGrantId: g!.id })).rejects.toThrow();
  });

  it("holds one upload row per server, matching supply_uploads' shape", async () => {
    const [s] = await db.insert(servers).values({ name: "T", map: "livonia", clockOffsetMs: 0, active: true }).returning();
    await db.insert(awardUploads).values({ serverId: s!.id, contentHash: "abc", uploadedAt: now });
    await expect(db.insert(awardUploads).values({ serverId: s!.id, contentHash: "def", uploadedAt: now })).rejects.toThrow();
  });
});
