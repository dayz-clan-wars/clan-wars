import { describe, it, expect, beforeEach } from "vitest";
import { createClient, runMigrations, requireTestDatabaseUrl, identityLinks, verificationChallenges, players, type Database } from "@factions/db";
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
    // SET LOCAL shares the truncate's connection (the pool hands out any
    // connection, and the setting reverts at commit), so the dozens of
    // "truncate cascades to ..." NOTICEs stay out of the suite's output and a
    // genuine warning is visible when one appears.
    await db.transaction(async (tx) => {
      await tx.execute(sql`set local client_min_messages = warning`);
      await tx.execute(sql`truncate table challenge_attempts, verification_challenges, identity_links, players restart identity cascade`);
    });
    store = new PgVerificationStore(db);
  });

  const issue = async (discordId = "100", targetDayzId = UID_A) => {
    const c = await store.createChallenge({
      discordId, guildId: "g", channelId: "c", sequence: SEQ, issuedAt: now, expiresAt: later, targetDayzId,
    });
    expect(c).not.toBeNull();
    return c!;
  };

  const seedPlayer = (opts: { dayzId: string; gamertag: string; lastSeenAt: Date; firstSeenAt?: Date }) =>
    db.insert(players).values({
      dayzId: opts.dayzId, gamertag: opts.gamertag,
      firstSeenAt: opts.firstSeenAt ?? opts.lastSeenAt, lastSeenAt: opts.lastSeenAt,
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

  it("upserts per-UID attempt progress", async () => {
    const c = await issue();
    await store.upsertAttempt(c.id, UID_A, 1, 10, 1);
    expect(await store.getAttempt(c.id, UID_A)).toMatchObject({ progressIndex: 1, lastMatchedEventId: 10, seenCount: 1 });
    await store.upsertAttempt(c.id, UID_A, 2, 11, 2);
    expect(await store.getAttempt(c.id, UID_A)).toMatchObject({ progressIndex: 2, lastMatchedEventId: 11, seenCount: 2 });
  });

  it("keeps two UIDs' progress on one challenge independent", async () => {
    const c = await issue();
    await store.upsertAttempt(c.id, UID_A, 2, 10, 2);
    await store.upsertAttempt(c.id, UID_B, 0, 11, 1);
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
      discordId: "200", guildId: "g", channelId: "c", sequence: SEQ, issuedAt: now, expiresAt: later, targetDayzId: UID_A,
    });
    expect(second).not.toBeNull();
    expect(await store.completeChallenge(second!.id, UID_A, "Steve", later)).toBe(false);
    expect(await store.findLinkByDiscord("200")).toBeNull();
  });

  it("refuses to bind a UID the challenge does not name", async () => {
    // The store-level half of THE security property. The tick has its own
    // UID-equality guard, but the store must not depend on it: a caller that
    // passes the wrong UID must get no link row and no state change at all.
    // Without the equality check inside the FOR UPDATE transaction, the
    // identity_links INSERT still runs — binding this account to a UID its
    // challenge never named — and only the challenge UPDATE is refused, so
    // the caller sees `false` while the wrong link sits committed and the
    // challenge stays open, holding both index slots for its full TTL.
    const c = await issue("700", UID_A);

    expect(await store.completeChallenge(c.id, UID_B, "Mallory", later)).toBe(false);

    expect(await db.select().from(identityLinks), "no link may be written for a UID the challenge does not name")
      .toHaveLength(0);
    const [row] = await db.select().from(verificationChallenges)
      .where(eq(verificationChallenges.id, c.id));
    expect(row?.completedAt).toBeNull();
    // Left open, not canceled: the wrong-UID caller must not be able to close
    // someone else's challenge either.
    expect(row?.canceledAt).toBeNull();
    expect(await store.findLiveChallenge("700", now)).not.toBeNull();
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
    // the loser must not be left marked complete. Distinct targets and
    // distinct accounts satisfy uniqOpenTarget/uniqOpenPerAccount so both
    // challenges can be open at once; distinct sequences are incidental — the
    // open-sequence uniqueness index this used to route around is gone.
    const a = await store.createChallenge({
      discordId: "401", guildId: "g", channelId: "c", sequence: SEQ, issuedAt: now, expiresAt: later, targetDayzId: UID_A,
    });
    const b = await store.createChallenge({
      discordId: "402", guildId: "g", channelId: "c", sequence: SEQ_B, issuedAt: now, expiresAt: later, targetDayzId: UID_B,
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

  it("refuses to complete a challenge that was canceled after it was read as live", async () => {
    // The tick pins `now` at tick start and re-reads challenges as it goes, so
    // a challenge can be canceled by a concurrent /link (cancelExpired) between
    // being listed as live and being completed. Completing it anyway violates
    // verification_challenges_single_outcome, and the throw aborts the whole
    // tick — the cursor is never written and the batch is redone forever.
    const c = await issue("600");
    await store.cancelExpired(new Date(later.getTime() + 1));

    expect(await store.completeChallenge(c.id, UID_A, "Steve", later)).toBe(false);

    const [row] = await db.select().from(verificationChallenges)
      .where(eq(verificationChallenges.id, c.id));
    expect(row?.completedAt, "a canceled challenge must not also be completed").toBeNull();
    // The loser of the race must not leave a link behind either.
    expect(await db.select().from(identityLinks).where(eq(identityLinks.dayzId, UID_A))).toHaveLength(0);
  });

  it("refuses to cancel a challenge that already completed", async () => {
    const c = await issue("601");
    expect(await store.completeChallenge(c.id, UID_A, "Steve", later)).toBe(true);

    await store.cancelExpired(new Date(later.getTime() + 1));

    const [row] = await db.select().from(verificationChallenges)
      .where(eq(verificationChallenges.id, c.id));
    expect(row?.canceledAt, "a completed challenge must not also be canceled").toBeNull();
  });

  it("is idempotent when the same account re-completes its own binding", async () => {
    const first = await store.createChallenge({
      discordId: "500", guildId: "g", channelId: "c", sequence: SEQ, issuedAt: now, expiresAt: later, targetDayzId: UID_B,
    });
    expect(first).not.toBeNull();
    expect(await store.completeChallenge(first!.id, UID_B, "Steve", later)).toBe(true);

    const second = await store.createChallenge({
      discordId: "500", guildId: "g", channelId: "c", sequence: SEQ, issuedAt: now, expiresAt: later, targetDayzId: UID_B,
    });
    expect(second).not.toBeNull();
    // Same account, same UID — already bound, so this succeeds without a
    // second insert rather than being treated as a loser of the race.
    expect(await store.completeChallenge(second!.id, UID_B, "Steve", later)).toBe(true);
    const links = await db.select().from(identityLinks).where(eq(identityLinks.dayzId, UID_B));
    expect(links).toHaveLength(1);
  });

  it("refuses a second open challenge for the same character", async () => {
    // Used to cover verification_challenges_open_sequence_uniq. That index was
    // retired (see schema.ts's tombstone comment on the target column — three
    // emotes over 24 tokens collide routinely, so blocking on shared sequences
    // would actively break /link) and replaced by
    // verification_challenges_open_target_uniq: `second` conflicts here
    // because it names the same target UID as `first`, not because it shares
    // a sequence.
    const first = await issue("100");
    expect(first).not.toBeNull();
    const second = await store.createChallenge({
      discordId: "200", guildId: "g", channelId: "c", sequence: SEQ, issuedAt: now, expiresAt: later, targetDayzId: UID_A,
    });
    // Null, not a throw — the caller redraws.
    expect(second).toBeNull();
  });

  it("frees a target UID once its challenge is canceled as expired", async () => {
    // Also formerly about the retired open-sequence index (see the comment
    // above). Both challenges here reuse SEQ, which no longer matters — what
    // makes `reused` non-null is that canceling the first frees its target
    // UID from verification_challenges_open_target_uniq, since `reused` names
    // the same target (UID_A).
    await store.createChallenge({
      discordId: "300", guildId: "g", channelId: "c", sequence: SEQ,
      issuedAt: now, expiresAt: new Date(now.getTime() - 1), targetDayzId: UID_A,
    });
    expect(await store.cancelExpired(now)).toBe(1);
    const reused = await store.createChallenge({
      discordId: "400", guildId: "g", channelId: "c", sequence: SEQ, issuedAt: now, expiresAt: later, targetDayzId: UID_A,
    });
    expect(reused).not.toBeNull();
  });

  it("does not cancel a challenge that is still live", async () => {
    await issue("500");
    expect(await store.cancelExpired(now)).toBe(0);
  });

  it("refuses to cancel ONE challenge that already completed", async () => {
    // Distinct from the cancelExpired test above: this is the targeted
    // cancelChallenge path the budget-exhaustion cancel uses.
    // The guard is the half that matters: without it, a stray cancelChallenge
    // call on an already-bound challenge would either corrupt it (violating
    // verification_challenges_single_outcome) or throw and poison the
    // verificationTick cursor loop forever.
    const c = await issue("600");
    await store.completeChallenge(c.id, UID_A, "Steve", later);
    expect(await store.cancelChallenge(c.id, later)).toBe(false);
    const [row] = await db.select().from(verificationChallenges)
      .where(eq(verificationChallenges.id, c.id));
    expect(row!.canceledAt).toBeNull();
  });

  it("offers recently seen players, newest first, excluding the linked", async () => {
    const A = "a".repeat(40), B = "b".repeat(40), C = "c".repeat(40);
    await seedPlayer({ dayzId: A, gamertag: "Older", lastSeenAt: new Date("2026-09-01T00:00:00Z") });
    await seedPlayer({ dayzId: B, gamertag: "Newer", lastSeenAt: new Date("2026-09-02T00:00:00Z") });
    await seedPlayer({ dayzId: C, gamertag: "Taken", lastSeenAt: new Date("2026-09-03T00:00:00Z") });
    await db.insert(identityLinks).values({ discordId: "d9", dayzId: C, gamertag: "Taken", verifiedAt: new Date() });
    expect(await store.recentUnlinkedPlayers(50)).toEqual([
      { dayzId: B, gamertag: "Newer" },
      { dayzId: A, gamertag: "Older" },
    ]);
  });

  it("honours the limit", async () => {
    // The autocomplete's pool is 50; Discord returns at most 25 of them.
    for (let i = 0; i < 60; i++) {
      await seedPlayer({ dayzId: `${i}`.padStart(40, "0"), gamertag: `P${i}`,
        lastSeenAt: new Date(Date.UTC(2026, 8, 1, 0, i)) });
    }
    expect(await store.recentUnlinkedPlayers(50)).toHaveLength(50);
  });
});
