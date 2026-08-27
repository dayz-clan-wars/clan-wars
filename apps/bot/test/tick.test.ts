import { describe, it, expect, beforeEach } from "vitest";
import { createClient, runMigrations, requireTestDatabaseUrl, servers, admFiles, type Database } from "@factions/db";
import { appendEvent } from "@factions/event-log";
import { sql } from "drizzle-orm";
import { PgVerificationStore } from "../src/store.js";
import { verificationTick, CONSUMER } from "../src/tick.js";

const URL = requireTestDatabaseUrl();
const UID_A = "A".repeat(40);
const UID_B = "B".repeat(40);
const SEQ = ["EmoteSalute", "EmoteClap", "EmoteDance"];

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

  const issue = async (discordId = "100") => {
    const c = await store.createChallenge({
      discordId, guildId: "g", channelId: "c", sequence: SEQ, issuedAt: now, expiresAt: later,
    });
    expect(c).not.toBeNull();
    return c!;
  };

  const tick = () => verificationTick(db, store, { batchSize: 100, now });

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
});
