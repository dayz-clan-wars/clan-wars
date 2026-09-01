import { describe, it, expect, beforeEach } from "vitest";
import { createClient, runMigrations, requireTestDatabaseUrl, servers, admFiles, verificationChallenges, identityLinks, type Database } from "@factions/db";
import { appendEvent } from "@factions/event-log";
import { safeVerificationEmotes } from "@factions/domain";
import { sql, eq } from "drizzle-orm";
import { PgVerificationStore } from "../src/store.js";
import { verificationTick, CONSUMER } from "../src/tick.js";

const URL = requireTestDatabaseUrl();
const UID_A = "A".repeat(40);
const UID_B = "B".repeat(40);
const SEQ = ["EmoteSalute", "EmoteClap", "EmoteDance"];
const TARGET = "C".repeat(40);
const IMPOSTOR = "D".repeat(40);

describe("verificationTick", () => {
  let db: Database;
  let store: PgVerificationStore;
  let serverId = 0;
  let admFileId = 0;
  let line = 0;
  const now = new Date("2026-08-26T12:00:00Z");
  const later = new Date("2026-08-26T12:10:00Z");

  beforeEach(async () => {
    db = createClient(URL);
    await runMigrations(db);
    await db.execute(sql`truncate table challenge_attempts, verification_challenges, identity_links, consumer_cursors, events, raw_lines, adm_files, servers restart identity cascade`);
    store = new PgVerificationStore(db);
    const [s] = await db.insert(servers).values({ name: "S", map: "sakhal", clockOffsetMs: 0 }).returning();
    serverId = s!.id;
    const [f] = await db.insert(admFiles).values({ serverId, filename: "f.ADM", bootAt: now }).returning();
    admFileId = f!.id;
    line = 0;
  });

  const emote = (dayzId: string, token: string, gamertag = "Steve") => appendEvent(db, {
    serverId, admFileId, lineIndex: line++, subIndex: 0,
    type: "emote.performed", occurredAt: now,
    payload: { gamertag, dayzId, emote: token, item: null },
  });

  const issue = async (discordId = "100", targetDayzId = UID_A) => {
    const c = await store.createChallenge({
      discordId, guildId: "g", channelId: "c", sequence: SEQ, issuedAt: now, expiresAt: later, targetDayzId,
    });
    expect(c).not.toBeNull();
    return c!;
  };

  const tick = () => verificationTick(db, store, { batchSize: 100, now });

  const seedChallenge = async (opts: { discordId: string; targetDayzId: string; sequence: string[] }) => {
    const c = await store.createChallenge({
      discordId: opts.discordId, guildId: "g", channelId: "c",
      sequence: opts.sequence, issuedAt: now, expiresAt: later, targetDayzId: opts.targetDayzId,
    });
    expect(c).not.toBeNull();
    return c!;
  };

  const seedEmote = (opts: { dayzId: string; gamertag: string; emote: string }) => appendEvent(db, {
    serverId, admFileId, lineIndex: line++, subIndex: 0,
    type: "emote.performed", occurredAt: now,
    payload: { gamertag: opts.gamertag, dayzId: opts.dayzId, emote: opts.emote, item: null },
  });

  it("does nothing with no events", async () => {
    expect(await tick()).toMatchObject({ scanned: 0, verified: 0 });
  });

  it("verifies a UID that performs the full sequence in order", async () => {
    await issue();
    for (const t of SEQ) await emote(UID_A, t);
    const r = await tick();
    expect(r.verified).toBe(1);
    expect(await store.findLinkByDiscord("100")).toMatchObject({ dayzId: UID_A });
  });

  it("does not verify a partial sequence", async () => {
    await issue();
    await emote(UID_A, SEQ[0]!);
    await emote(UID_A, SEQ[1]!);
    expect((await tick()).verified).toBe(0);
    expect(await store.findLinkByDiscord("100")).toBeNull();
  });

  it("does not verify an out-of-order sequence", async () => {
    await issue();
    await emote(UID_A, SEQ[2]!);
    await emote(UID_A, SEQ[1]!);
    await emote(UID_A, SEQ[0]!);
    expect((await tick()).verified).toBe(0);
  });

  it("tolerates unrelated emotes between the steps", async () => {
    await issue();
    await emote(UID_A, SEQ[0]!);
    await emote(UID_A, "EmoteShrug");
    await emote(UID_A, SEQ[1]!);
    await emote(UID_A, "EmoteSitA");
    await emote(UID_A, SEQ[2]!);
    expect((await tick()).verified).toBe(1);
  });

  it("does NOT let two UIDs jointly complete one challenge", async () => {
    await issue();
    await emote(UID_A, SEQ[0]!);
    await emote(UID_B, SEQ[1]!);
    await emote(UID_A, SEQ[2]!);
    expect((await tick()).verified).toBe(0);
    expect(await store.findLinkByDiscord("100")).toBeNull();
  });

  it("ignores an expired challenge", async () => {
    await store.createChallenge({
      discordId: "100", guildId: "g", channelId: "c", sequence: SEQ,
      issuedAt: new Date("2026-08-26T11:00:00Z"), expiresAt: new Date("2026-08-26T11:10:00Z"),
      targetDayzId: UID_A,
    });
    for (const t of SEQ) await emote(UID_A, t);
    expect((await tick()).verified).toBe(0);
  });

  it("refuses to bind a UID that is already linked elsewhere", async () => {
    const first = await issue("100");
    await store.completeChallenge(first.id, UID_A, "Steve", now);
    await issue("200");
    for (const t of SEQ) await emote(UID_A, t);
    const r = await tick();
    expect(r.alreadyLinked).toBe(1);
    expect(await store.findLinkByDiscord("200")).toBeNull();
  });

  it("advances its own cursor, not the projector's", async () => {
    await issue();
    await emote(UID_A, SEQ[0]!);
    await tick();
    const [row] = await db.select().from((await import("@factions/db")).consumerCursors);
    expect(row?.consumerName).toBe(CONSUMER);
  });

  it("is idempotent across repeated ticks", async () => {
    await issue();
    for (const t of SEQ) await emote(UID_A, t);
    expect((await tick()).verified).toBe(1);
    expect((await tick()).verified).toBe(0);
  });

  it("ignores non-emote events", async () => {
    await issue();
    await appendEvent(db, {
      serverId, admFileId, lineIndex: line++, subIndex: 0,
      type: "player.position", occurredAt: now, payload: { dayzId: UID_A },
    });
    expect((await tick()).scanned).toBe(0);
  });

  it("skips a malformed emote payload rather than throwing", async () => {
    await issue();
    await appendEvent(db, {
      serverId, admFileId, lineIndex: line++, subIndex: 0,
      type: "emote.performed", occurredAt: now, payload: { nonsense: true },
    });
    await expect(tick()).resolves.toMatchObject({ verified: 0 });
  });

  it("retries a completion whose first attempt failed, rather than skipping the event", async () => {
    // Simulates the mid-batch failure: the completing event is processed while
    // completeChallenge throws, then the same batch is processed again.
    await issue();
    for (const t of SEQ) await emote(UID_A, t);

    const failing = Object.create(store) as typeof store;
    let thrown = false;
    failing.completeChallenge = async (...args: Parameters<typeof store.completeChallenge>) => {
      if (!thrown) { thrown = true; throw new Error("transient db error"); }
      return store.completeChallenge(...args);
    };

    await expect(verificationTick(db, failing, { batchSize: 100, now })).rejects.toThrow("transient db error");
    expect(await store.findLinkByDiscord("100")).toBeNull();

    // The cursor was never written, so the batch replays. The completing event
    // must NOT be skipped by the replay guard.
    const second = await verificationTick(db, store, { batchSize: 100, now });
    expect(second.verified).toBe(1);
    expect(await store.findLinkByDiscord("100")).toMatchObject({ dayzId: UID_A });
  });

  it("skips an emote payload with an empty gamertag", async () => {
    await issue();
    await appendEvent(db, {
      serverId, admFileId, lineIndex: line++, subIndex: 0,
      type: "emote.performed", occurredAt: now,
      payload: { gamertag: "", dayzId: UID_A, emote: SEQ[0]!, item: null },
    });
    expect((await tick()).scanned).toBe(0);
  });

  it("ignores emotes performed before the challenge was issued", async () => {
    // The event exists in the log but predates the challenge, so it must not
    // count toward it — otherwise a historical backfill binds a stranger's UID.
    const past = new Date(now.getTime() - 60_000);
    await issue();
    for (const t of SEQ) {
      await appendEvent(db, {
        serverId, admFileId, lineIndex: line++, subIndex: 0,
        type: "emote.performed", occurredAt: past,
        payload: { gamertag: "Steve", dayzId: UID_A, emote: t, item: null },
      });
    }
    expect((await tick()).verified).toBe(0);
    expect(await store.findLinkByDiscord("100")).toBeNull();
  });

  it("locks out a UID that sweeps the whole safe pool", async () => {
    // The C2 attack: perform every safe token in a fixed order, three times
    // over. That contains every ordered triple as a subsequence, so without a
    // budget it completes any sequence without ever seeing it. The sweep is
    // done in REVERSE dictionary order so it cannot accidentally line up with
    // SEQ's own (ascending, dictionary-order) tokens within the budget window
    // — this must exercise the general attack, not a coincidence of fixture
    // ordering.
    await issue();
    const pool = safeVerificationEmotes().map((e) => e.token).reverse();
    for (const t of [...pool, ...pool, ...pool]) await emote(UID_A, t);
    const r = await tick();
    expect(r.verified).toBe(0);
    expect(r.lockedOut).toBeGreaterThan(0);
    expect(await store.findLinkByDiscord("100")).toBeNull();
  });

  it("locks out a partial sweep before it can cover a sequence", async () => {
    // The sweep test above proves the budget stops an EXHAUSTIVE sweep. It does
    // not prove the budget is tight enough, and at 12 it was not: because
    // matching holds on mismatch, a run of n distinct emotes covers every
    // ordered length-k subsequence of itself — C(12, 3) = 220 of 24×23×22 =
    // 12,144 sequences, ~1.8%. Since a challenge only advances for the UID it
    // names, this is now the named target accidentally covering their own
    // sequence, not a stranger's sweep landing on it by luck.
    //
    // So: a run whose only occurrence of the challenge sequence lies past the
    // budget must not complete it. This fixture is that run — the sequence sits
    // in the tail, reachable within 12 emotes but not within 8.
    const pool = safeVerificationEmotes().map((e) => e.token);
    const filler = pool.filter((t) => !SEQ.includes(t)).slice(0, 8);
    expect(filler).toHaveLength(8);
    await issue();
    for (const t of [...filler, ...SEQ]) await emote(UID_A, t);
    const r = await tick();
    expect(r.verified, "the sequence lies past the budget and must not complete").toBe(0);
    expect(r.lockedOut).toBeGreaterThan(0);
    expect(await store.findLinkByDiscord("100")).toBeNull();
  });

  it("still verifies a legitimate player who fumbles a few emotes first", async () => {
    // The budget must not punish normal play: a few wrong emotes, then the
    // right three in order. SEQ is EmoteSalute/EmoteClap/EmoteDance, so use
    // different filler tokens here.
    await issue();
    await emote(UID_A, "EmoteShrug");
    await emote(UID_A, "EmoteHeart");
    for (const t of SEQ) await emote(UID_A, t);
    expect((await tick()).verified).toBe(1);
  });

  it("does not advance a challenge for a DIFFERENT character's emotes", async () => {
    // ⚠️ THE security property. A challenge names its target; only that
    // character can advance it. Delete the dayzId comparison in tick.ts and
    // this test must go red — it is the whole reason three emotes is enough.
    const challenge = await seedChallenge({ discordId: "d1", targetDayzId: TARGET,
      sequence: ["EmoteSalute", "EmoteClap", "EmoteNod"] });
    for (const emote of ["EmoteSalute", "EmoteClap", "EmoteNod"]) {
      await seedEmote({ dayzId: IMPOSTOR, gamertag: "Impostor", emote });
    }
    const r = await verificationTick(db, store, { now });
    expect(r.verified).toBe(0);
    expect(r.advanced).toBe(0);
    const [row] = await db.select().from(verificationChallenges)
      .where(eq(verificationChallenges.id, challenge.id));
    expect(row!.completedAt).toBeNull();
    expect(row!.boundDayzId).toBeNull();
  });

  it("completes when the NAMED character performs the sequence", async () => {
    const challenge = await seedChallenge({ discordId: "d1", targetDayzId: TARGET,
      sequence: ["EmoteSalute", "EmoteClap", "EmoteNod"] });
    for (const emote of ["EmoteSalute", "EmoteClap", "EmoteNod"]) {
      await seedEmote({ dayzId: TARGET, gamertag: "Ronald", emote });
    }
    const r = await verificationTick(db, store, { now });
    expect(r.verified).toBe(1);
    const [link] = await db.select().from(identityLinks);
    expect(link!.dayzId).toBe(TARGET);
    expect(link!.discordId).toBe("d1");
  });

  it("cancels a challenge whose budget is exhausted", async () => {
    // With a 24h TTL, an inert budget-exhausted challenge would hold the
    // player's one open slot for a day. Cancelled, they can /link again.
    const challenge = await seedChallenge({ discordId: "d1", targetDayzId: TARGET,
      sequence: ["EmoteSalute", "EmoteClap", "EmoteNod"] });
    // Nine safe emotes that never match the sequence.
    for (const emote of ["EmoteHeart", "EmoteDance", "EmoteShrug", "EmoteMove", "EmoteCome",
                         "EmoteSilent", "EmoteWatching", "EmoteThroat", "EmotePoint"]) {
      await seedEmote({ dayzId: TARGET, gamertag: "Ronald", emote });
    }
    await verificationTick(db, store, { now });
    const [row] = await db.select().from(verificationChallenges)
      .where(eq(verificationChallenges.id, challenge.id));
    expect(row!.canceledAt).not.toBeNull();
  });
});
