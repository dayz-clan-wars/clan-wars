import { describe, it, expect, beforeEach } from "vitest";
import { createClient, runMigrations, requireTestDatabaseUrl, identityLinks, verificationChallenges, type Database } from "@factions/db";
import { sql, eq, isNotNull } from "drizzle-orm";
import { PgVerificationStore } from "../src/store.js";

const URL = requireTestDatabaseUrl();
const UID_A = "A".repeat(40);
const UID_B = "B".repeat(40);
const SEQ = ["EmoteSalute", "EmoteClap", "EmoteDance"];
const SEQ_B = ["EmoteWave", "EmoteSitA", "EmoteWave2"];

describe("PgVerificationStore", () => {
  let db: Database;
  let store: PgVerificationStore;
  const now = new Date("2026-08-26T12:00:00Z");
  const later = new Date("2026-08-26T12:10:00Z");

  beforeEach(async () => {
    db = createClient(URL);
    await runMigrations(db);
    await db.execute(sql`truncate table challenge_attempts, verification_challenges, identity_links restart identity cascade`);
    store = new PgVerificationStore(db);
  });

  const issue = async (discordId = "100") => {
    const c = await store.createChallenge({
      discordId, guildId: "g", channelId: "c", sequence: SEQ, issuedAt: now, expiresAt: later,
    });
    expect(c).not.toBeNull();
    return c!;
  };

  it("finds no link for an unknown Discord account", async () => {
    expect(await store.findLinkByDiscord("nobody")).toBeNull();
  });

  it("creates and finds a live challenge", async () => {
    const c = await issue();
    expect(await store.findLiveChallenge("100", now)).toMatchObject({ id: c.id, sequence: SEQ });
  });

  it("does not return an expired challenge as live", async () => {
    await issue();
    expect(await store.findLiveChallenge("100", new Date("2026-08-26T12:11:00Z"))).toBeNull();
  });

  it("lists outstanding sequences so issuance can avoid collisions", async () => {
    await issue();
    expect(await store.outstandingSequences(now)).toEqual([SEQ]);
  });

  it("upserts per-UID attempt progress", async () => {
    const c = await issue();
    await store.upsertAttempt(c.id, UID_A, 1, 10);
    expect(await store.getAttempt(c.id, UID_A)).toMatchObject({ progressIndex: 1, lastMatchedEventId: 10 });
    await store.upsertAttempt(c.id, UID_A, 2, 11);
    expect(await store.getAttempt(c.id, UID_A)).toMatchObject({ progressIndex: 2, lastMatchedEventId: 11 });
  });

  it("keeps two UIDs' progress on one challenge independent", async () => {
    const c = await issue();
    await store.upsertAttempt(c.id, UID_A, 2, 10);
    await store.upsertAttempt(c.id, UID_B, 0, 11);
    expect((await store.getAttempt(c.id, UID_A))?.progressIndex).toBe(2);
    expect((await store.getAttempt(c.id, UID_B))?.progressIndex).toBe(0);
  });

  it("completes a challenge and writes the link", async () => {
    const c = await issue();
    expect(await store.completeChallenge(c.id, UID_A, "Steve", later)).toBe(true);
    expect(await store.findLinkByDiscord("100")).toMatchObject({ dayzId: UID_A, gamertag: "Steve" });
    expect(await store.findLiveChallenge("100", now)).toBeNull();
  });

  it("refuses to complete when the UID already belongs to someone else", async () => {
    const first = await issue("100");
    await store.completeChallenge(first.id, UID_A, "Steve", later);
    const second = await store.createChallenge({
      discordId: "200", guildId: "g", channelId: "c", sequence: SEQ, issuedAt: now, expiresAt: later,
    });
    expect(second).not.toBeNull();
    expect(await store.completeChallenge(second!.id, UID_A, "Steve", later)).toBe(false);
    expect(await store.findLinkByDiscord("200")).toBeNull();
  });

  it("deletes a link and reports whether one existed", async () => {
    const c = await issue();
    await store.completeChallenge(c.id, UID_A, "Steve", later);
    expect(await store.deleteLinkByDiscord("100")).toBe(true);
    expect(await store.deleteLinkByDiscord("100")).toBe(false);
  });

  it("surfaces completed challenges awaiting notification exactly once", async () => {
    const c = await issue();
    await store.completeChallenge(c.id, UID_A, "Steve", later);
    const pending = await store.pendingNotifications();
    expect(pending.map((p) => p.id)).toEqual([c.id]);
    await store.markNotified(c.id, later);
    expect(await store.pendingNotifications()).toEqual([]);
  });

  it("never completes a challenge without writing its link, under concurrency", async () => {
    // Two Discord accounts racing for the SAME UID. Exactly one may win, and
    // the loser must not be left marked complete. Distinct sequences: the
    // open-sequence uniqueness index is a separate concern from this race.
    const a = await store.createChallenge({
      discordId: "401", guildId: "g", channelId: "c", sequence: SEQ, issuedAt: now, expiresAt: later,
    });
    const b = await store.createChallenge({
      discordId: "402", guildId: "g", channelId: "c", sequence: SEQ_B, issuedAt: now, expiresAt: later,
    });
    expect(a).not.toBeNull();
    expect(b).not.toBeNull();

    const results = await Promise.all([
      store.completeChallenge(a!.id, UID_A, "Steve", later),
      store.completeChallenge(b!.id, UID_A, "Steve", later),
    ]);

    expect(results.filter(Boolean)).toHaveLength(1);

    const links = await db.select().from(identityLinks).where(eq(identityLinks.dayzId, UID_A));
    expect(links).toHaveLength(1);

    // The invariant that actually matters: every completed challenge has a
    // link row for its Discord account.
    const completed = await db.select().from(verificationChallenges)
      .where(isNotNull(verificationChallenges.completedAt));
    for (const c of completed) {
      const [link] = await db.select().from(identityLinks)
        .where(eq(identityLinks.discordId, c.discordId));
      expect(link, `challenge ${c.id} completed with no link for ${c.discordId}`).toBeDefined();
    }
  });

  it("is idempotent when the same account re-completes its own binding", async () => {
    const first = await store.createChallenge({
      discordId: "500", guildId: "g", channelId: "c", sequence: SEQ, issuedAt: now, expiresAt: later,
    });
    expect(first).not.toBeNull();
    expect(await store.completeChallenge(first!.id, UID_B, "Steve", later)).toBe(true);

    const second = await store.createChallenge({
      discordId: "500", guildId: "g", channelId: "c", sequence: SEQ, issuedAt: now, expiresAt: later,
    });
    expect(second).not.toBeNull();
    // Same account, same UID — already bound, so this succeeds without a
    // second insert rather than being treated as a loser of the race.
    expect(await store.completeChallenge(second!.id, UID_B, "Steve", later)).toBe(true);
    const links = await db.select().from(identityLinks).where(eq(identityLinks.dayzId, UID_B));
    expect(links).toHaveLength(1);
  });

  it("refuses a second open challenge holding the same sequence", async () => {
    const first = await issue("100");
    expect(first).not.toBeNull();
    const second = await store.createChallenge({
      discordId: "200", guildId: "g", channelId: "c", sequence: SEQ, issuedAt: now, expiresAt: later,
    });
    // Null, not a throw — the caller redraws.
    expect(second).toBeNull();
  });

  it("frees a sequence once its challenge is canceled as expired", async () => {
    await store.createChallenge({
      discordId: "300", guildId: "g", channelId: "c", sequence: SEQ,
      issuedAt: now, expiresAt: new Date(now.getTime() - 1),
    });
    expect(await store.cancelExpired(now)).toBe(1);
    const reused = await store.createChallenge({
      discordId: "400", guildId: "g", channelId: "c", sequence: SEQ, issuedAt: now, expiresAt: later,
    });
    expect(reused).not.toBeNull();
  });

  it("does not cancel a challenge that is still live", async () => {
    await issue("500");
    expect(await store.cancelExpired(now)).toBe(0);
  });
});
