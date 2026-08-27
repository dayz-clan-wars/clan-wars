import { describe, it, expect, beforeAll } from "vitest";
import {
  createClient, runMigrations, requireTestDatabaseUrl,
  identityLinks, verificationChallenges, challengeAttempts, type Database,
} from "../src/index.js";
import { sql } from "drizzle-orm";

const URL = requireTestDatabaseUrl();
const UID_A = "A".repeat(40);
const UID_B = "B".repeat(40);

describe("identity schema", () => {
  let db: Database;

  beforeAll(async () => {
    db = createClient(URL);
    await runMigrations(db);
    await db.execute(sql`truncate table challenge_attempts, verification_challenges, identity_links restart identity cascade`);
  });

  it("stores a verified link", async () => {
    const [row] = await db.insert(identityLinks).values({
      discordId: "100", dayzId: UID_A, gamertag: "Steve", verifiedAt: new Date(),
    }).returning();
    expect(row?.id).toBeGreaterThan(0);
  });

  it("allows only one link per Discord account", async () => {
    await expect(db.insert(identityLinks).values({
      discordId: "100", dayzId: UID_B, gamertag: "Other", verifiedAt: new Date(),
    })).rejects.toThrow();
  });

  it("allows only one link per DayZ UID", async () => {
    await expect(db.insert(identityLinks).values({
      discordId: "999", dayzId: UID_A, gamertag: "Steve", verifiedAt: new Date(),
    })).rejects.toThrow();
  });

  it("stores a challenge with its sequence as an array", async () => {
    const [row] = await db.insert(verificationChallenges).values({
      discordId: "200", guildId: "g1", channelId: "c1",
      sequence: ["EmoteSalute", "EmoteClap", "EmoteDance"],
      issuedAt: new Date(), expiresAt: new Date(Date.now() + 600_000),
    }).returning();
    expect(row?.sequence).toEqual(["EmoteSalute", "EmoteClap", "EmoteDance"]);
    expect(row?.completedAt).toBeNull();
  });

  it("tracks progress per (challenge, dayz_id)", async () => {
    const [c] = await db.insert(verificationChallenges).values({
      discordId: "300", guildId: "g1", channelId: "c1",
      sequence: ["EmoteSalute"], issuedAt: new Date(), expiresAt: new Date(Date.now() + 600_000),
    }).returning();

    await db.insert(challengeAttempts).values({ challengeId: c!.id, dayzId: UID_A, progressIndex: 1 });
    // A DIFFERENT UID attempting the same challenge is a separate row, not a conflict.
    const [second] = await db.insert(challengeAttempts)
      .values({ challengeId: c!.id, dayzId: UID_B, progressIndex: 0 }).returning();
    expect(second?.id).toBeGreaterThan(0);

    // The same UID twice on one challenge is a conflict.
    await expect(db.insert(challengeAttempts)
      .values({ challengeId: c!.id, dayzId: UID_A, progressIndex: 0 })).rejects.toThrow();
  });

  describe("challenge state constraints", () => {
    const base = {
      discordId: "900", guildId: "g", channelId: "c",
      sequence: ["EmoteSalute"], issuedAt: new Date(), expiresAt: new Date(Date.now() + 600_000),
    };

    it("rejects bound_dayz_id without a completion", async () => {
      await expect(db.insert(verificationChallenges)
        .values({ ...base, boundDayzId: UID_A })).rejects.toThrow();
    });

    it("rejects notified_at without a completion", async () => {
      await expect(db.insert(verificationChallenges)
        .values({ ...base, notifiedAt: new Date() })).rejects.toThrow();
    });

    it("rejects a challenge that is both completed and canceled", async () => {
      await expect(db.insert(verificationChallenges)
        .values({ ...base, completedAt: new Date(), canceledAt: new Date() })).rejects.toThrow();
    });

    it("accepts a completed challenge with its bound UID and notification", async () => {
      const now = new Date();
      const [row] = await db.insert(verificationChallenges)
        .values({ ...base, completedAt: now, boundDayzId: UID_B, notifiedAt: now }).returning();
      expect(row?.boundDayzId).toBe(UID_B);
    });
  });
});
