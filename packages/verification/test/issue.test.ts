import { describe, it, expect, beforeEach } from "vitest";
import { createClient, runMigrations, requireTestDatabaseUrl, identityLinks, players, verificationChallenges, type Database } from "@factions/db";
import { sql, eq } from "drizzle-orm";
import { PgVerificationStore } from "../src/store";
import { issueChallenge, MAX_DRAWS_PER_TARGET, type IssueDeps } from "../src/issue";

const URL = requireTestDatabaseUrl();
const UID_A = "A".repeat(40);
const UID_B = "B".repeat(40);
const now = new Date("2026-09-05T12:00:00Z");
const TTL = 600_000;

describe("issueChallenge", () => {
  let db: Database;
  let store: PgVerificationStore;
  const deps: IssueDeps = { rng: Math.random, now, ttlMs: TTL };
  const ctx = (targetDayzId = UID_A, extra: Partial<{ newSequence: boolean; discordId: string }> = {}) =>
    ({ discordId: "100", targetDayzId, guildId: null, channelId: null, ...extra });

  beforeEach(async () => {
    db = createClient(URL);
    await runMigrations(db);
    await db.transaction(async (tx) => {
      await tx.execute(sql`set local client_min_messages = warning`);
      await tx.execute(sql`truncate table challenge_attempts, verification_challenges, identity_links, players restart identity cascade`);
    });
    store = new PgVerificationStore(db);
    await db.insert(players).values([
      { dayzId: UID_A, gamertag: "Ronald", firstSeenAt: now, lastSeenAt: now },
      { dayzId: UID_B, gamertag: "Betty", firstSeenAt: now, lastSeenAt: now },
    ]);
  });

  it("refuses an account that is already linked", async () => {
    await db.insert(identityLinks).values({ discordId: "100", dayzId: UID_B, gamertag: "Betty", verifiedAt: now });
    expect(await issueChallenge(store, deps, ctx())).toEqual({ kind: "already-linked", gamertag: "Betty" });
  });

  it("refuses a character the log has never seen", async () => {
    expect(await issueChallenge(store, deps, ctx("F".repeat(40)))).toEqual({ kind: "unknown-character" });
  });

  it("refuses a character linked to another account", async () => {
    await db.insert(identityLinks).values({ discordId: "200", dayzId: UID_A, gamertag: "Ronald", verifiedAt: now });
    expect(await issueChallenge(store, deps, ctx())).toEqual({ kind: "taken", gamertag: "Ronald" });
  });

  it("issues with the site's shape: no guild, no channel, ttl from deps, three emotes", async () => {
    const out = await issueChallenge(store, deps, ctx());
    expect(out.kind).toBe("issued");
    if (out.kind !== "issued") return;
    expect(out.switchedFrom).toBeNull();
    expect(out.challenge).toMatchObject({ guildId: null, channelId: null, targetDayzId: UID_A });
    expect(out.challenge.sequence).toHaveLength(3);
    expect(out.challenge.expiresAt.getTime()).toBe(now.getTime() + TTL);
  });

  it("re-shows a live challenge for the same character instead of re-issuing", async () => {
    const first = await issueChallenge(store, deps, ctx());
    const again = await issueChallenge(store, deps, ctx());
    expect(again.kind).toBe("live");
    if (first.kind !== "issued" || again.kind !== "live") return;
    expect(again.challenge.id).toBe(first.challenge.id);
    expect(again.challenge.sequence).toEqual(first.challenge.sequence);
  });

  it("newSequence re-rolls; switching character cancels the old one and names it", async () => {
    const first = await issueChallenge(store, deps, ctx());
    const rerolled = await issueChallenge(store, deps, ctx(UID_A, { newSequence: true }));
    expect(rerolled.kind).toBe("issued");
    if (first.kind !== "issued" || rerolled.kind !== "issued") return;
    expect(rerolled.challenge.id).not.toBe(first.challenge.id);
    expect(rerolled.switchedFrom).toBeNull();
    const switched = await issueChallenge(store, deps, ctx(UID_B));
    expect(switched).toMatchObject({ kind: "issued", switchedFrom: "Ronald" });
    const [old] = await db.select().from(verificationChallenges).where(eq(verificationChallenges.id, rerolled.challenge.id));
    expect(old!.canceledAt).not.toBeNull();
    expect(old!.cancelReason).toBeNull();
  });

  it("caps draws per character per window, counting every draw", async () => {
    for (let i = 0; i < MAX_DRAWS_PER_TARGET; i++) {
      expect((await issueChallenge(store, deps, ctx(UID_A, { newSequence: true }))).kind).toBe("issued");
    }
    expect(await issueChallenge(store, deps, ctx(UID_A, { newSequence: true }))).toEqual({ kind: "too-many-draws", gamertag: "Ronald" });
  });

  it("reports a character another account is mid-way through verifying, with when that ends", async () => {
    const theirs = await issueChallenge(store, deps, ctx(UID_A, { discordId: "200" }));
    expect(theirs.kind).toBe("issued");
    const out = await issueChallenge(store, deps, ctx());
    expect(out).toEqual({ kind: "held-by-other", gamertag: "Ronald", expiresAt: new Date(now.getTime() + TTL) });
  });
});
