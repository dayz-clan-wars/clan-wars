import { describe, it, expect, beforeEach } from "vitest";
import { createClient, runMigrations, requireTestDatabaseUrl, type Database } from "@factions/db";
import { sql } from "drizzle-orm";
import { PgVerificationStore } from "../src/store.js";

const URL = requireTestDatabaseUrl();
const UID_A = "A".repeat(40);
const UID_B = "B".repeat(40);
const SEQ = ["EmoteSalute", "EmoteClap", "EmoteDance"];

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

  const issue = (discordId = "100") => store.createChallenge({
    discordId, guildId: "g", channelId: "c", sequence: SEQ, issuedAt: now, expiresAt: later,
  });

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
    expect(await store.completeChallenge(second.id, UID_A, "Steve", later)).toBe(false);
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
});
