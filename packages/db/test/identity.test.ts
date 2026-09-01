import { describe, it, expect, beforeAll } from "vitest";
import {
  createClient, runMigrations, requireTestDatabaseUrl,
  identityLinks, verificationChallenges, challengeAttempts, type Database,
} from "../src/index.js";
import { sql, inArray } from "drizzle-orm";

const URL = requireTestDatabaseUrl();
const UID_A = "A".repeat(40);
const UID_B = "B".repeat(40);
const TARGET = "T".repeat(40);
const A = "C".repeat(40);
const B = "D".repeat(40);

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
      targetDayzId: "E".repeat(40),
    }).returning();
    expect(row?.sequence).toEqual(["EmoteSalute", "EmoteClap", "EmoteDance"]);
    expect(row?.completedAt).toBeNull();
  });

  it("tracks progress per (challenge, dayz_id)", async () => {
    const [c] = await db.insert(verificationChallenges).values({
      discordId: "300", guildId: "g1", channelId: "c1",
      sequence: ["EmoteSalute"], issuedAt: new Date(), expiresAt: new Date(Date.now() + 600_000),
      targetDayzId: "F".repeat(40),
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
      targetDayzId: "G".repeat(40),
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

  it("refuses two live challenges for the same character", async () => {
    // Two Discord accounts must not race to bind one character.
    const base = {
      guildId: "g", channelId: "c", sequence: ["EmoteSalute"],
      issuedAt: new Date(), expiresAt: new Date(Date.now() + 3_600_000),
      targetDayzId: TARGET,
    };
    await db.insert(verificationChallenges).values({ ...base, discordId: "d1" });
    await expect(db.insert(verificationChallenges).values({ ...base, discordId: "d2" }))
      .rejects.toThrow(/verification_challenges_open_target_uniq/);
  });

  it("allows two live challenges to share a sequence", async () => {
    // The old open-sequence index is GONE. With 3 emotes over 24 tokens there
    // are only 12,144 sequences, so collisions are ordinary and must not
    // reject a legitimate /link. Safe because a challenge names its target.
    const seq = ["EmoteSalute", "EmoteClap", "EmoteNod"];
    const base = { guildId: "g", channelId: "c", sequence: seq,
      issuedAt: new Date(), expiresAt: new Date(Date.now() + 3_600_000) };
    await db.insert(verificationChallenges).values({ ...base, discordId: "d3", targetDayzId: A });
    await db.insert(verificationChallenges).values({ ...base, discordId: "d4", targetDayzId: B });
    // A plain full-table select would be brittle here: this file does not
    // truncate verification_challenges between tests, so rows from earlier
    // tests in this suite are still present. Filter to the two rows this
    // test itself inserted instead of relying on the table starting empty.
    const rows = await db.select().from(verificationChallenges)
      .where(inArray(verificationChallenges.targetDayzId, [A, B]));
    expect(rows).toHaveLength(2);
  });
});
