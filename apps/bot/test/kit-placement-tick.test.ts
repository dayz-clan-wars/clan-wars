import { describe, it, expect, beforeEach } from "vitest";
import {
  createClient, runMigrations, requireTestDatabaseUrl,
  servers, admFiles, identityLinks, boosterKits, boosterKitChallenges,
  type Database,
} from "@factions/db";
import { appendEvent, readCursor } from "@factions/event-log";
import { sql, isNull } from "drizzle-orm";
import { kitPlacementTick, KIT_PLACEMENT_CONSUMER, MAX_POOL_EMOTES_PER_ATTEMPT } from "../src/kit-placement-tick.js";
import { issuePlacementChallenge } from "../src/kit-placement-issue.js";
import { CONSUMER } from "../src/tick.js";

const URL = requireTestDatabaseUrl();
const TARGET = "A".repeat(40);
const IMPOSTOR = "B".repeat(40);

describe("kitPlacementTick", () => {
  let db: Database;
  let serverId = 0;
  let admFileId = 0;
  let line = 0;
  const issuedAt = new Date("2026-09-19T12:00:00Z");
  const now = new Date("2026-09-19T12:05:00Z");
  const expiresAt = new Date("2026-09-19T13:00:00Z");

  beforeEach(async () => {
    db = createClient(URL);
    await runMigrations(db);
    await db.transaction(async (tx) => {
      await tx.execute(sql`set local client_min_messages = warning`);
      await tx.execute(sql`truncate table booster_kit_challenges, booster_kits, identity_links, consumer_cursors, events, raw_lines, adm_files, servers restart identity cascade`);
    });
    const [s] = await db.insert(servers).values({ name: "S", map: "livonia", clockOffsetMs: 0 }).returning();
    serverId = s!.id;
    const [f] = await db.insert(admFiles).values({ serverId, filename: "f.ADM", bootAt: issuedAt }).returning();
    admFileId = f!.id;
    line = 0;
  });

  const seedKit = (discordId = "1", extra: Record<string, unknown> = {}) =>
    db.insert(boosterKits).values({ discordId, mask: "GasMask", ...extra });

  const seedChallenge = (opts: {
    discordId?: string; targetDayzId?: string; sequence?: string[];
    issuedAt?: Date; expiresAt?: Date; progressIndex?: number; seenCount?: number;
  } = {}) => db.insert(boosterKitChallenges).values({
    discordId: opts.discordId ?? "1",
    targetDayzId: opts.targetDayzId ?? TARGET,
    sequence: opts.sequence ?? ["EmoteSalute", "EmoteClap"],
    issuedAt: opts.issuedAt ?? issuedAt,
    expiresAt: opts.expiresAt ?? expiresAt,
    progressIndex: opts.progressIndex ?? 0,
    seenCount: opts.seenCount ?? 0,
  }).returning();

  // ⚠️ `pos` is the Vec3 the parser produces: y is ALWAYS altitude. The
  // fixtures below spell that out so a swap in the tick shows up here.
  const seedEmote = (opts: {
    dayzId?: string; emote: string; pos?: { x: number; y: number; z: number } | null; occurredAt?: Date;
  }) => appendEvent(db, {
    serverId, admFileId, lineIndex: line++, subIndex: 0,
    type: "emote.performed", occurredAt: opts.occurredAt ?? new Date("2026-09-19T12:01:00Z"),
    payload: {
      gamertag: "Steve", dayzId: opts.dayzId ?? TARGET, emote: opts.emote,
      item: null, pos: opts.pos === undefined ? { x: 300, y: 6, z: 400 } : opts.pos,
    },
  });

  const tick = (at: Date = now) => kitPlacementTick(db, { batchSize: 100, now: at });

  it("does nothing with no events", async () => {
    expect(await tick()).toMatchObject({ scanned: 0, advanced: 0, placed: 0 });
  });

  it("writes the position of the FINAL emote in the sequence", async () => {
    await seedKit();
    await seedChallenge();
    await seedEmote({ emote: "EmoteSalute", pos: { x: 100, y: 5, z: 200 } });
    await seedEmote({ emote: "EmoteClap", pos: { x: 300, y: 6, z: 400 } });

    const r = await tick();

    expect(r.placed).toBe(1);
    const [kit] = await db.select().from(boosterKits);
    // y is altitude in the payload AND in the column. No reordering happens.
    expect([Number(kit!.posX), Number(kit!.posY), Number(kit!.posZ)]).toEqual([300, 6, 400]);
    expect(kit!.placedAt).not.toBeNull();
    const [ch] = await db.select().from(boosterKitChallenges);
    expect(ch!.closedAt).not.toBeNull();
  });

  it("ignores emotes from a character the challenge does not name", async () => {
    await seedKit();
    await seedChallenge({ sequence: ["EmoteSalute"] });
    await seedEmote({ dayzId: IMPOSTOR, emote: "EmoteSalute" });

    const r = await tick();

    expect(r.placed).toBe(0);
    const [kit] = await db.select().from(boosterKits);
    expect(kit!.posX).toBeNull();
    const [ch] = await db.select().from(boosterKitChallenges);
    expect(ch!.closedAt).toBeNull();
  });

  it("does not place when the completing emote carries no position", async () => {
    await seedKit();
    await seedChallenge({ sequence: ["EmoteSalute"] });
    await seedEmote({ emote: "EmoteSalute", pos: null });

    const r = await tick();

    expect(r.placed).toBe(0);
    const [kit] = await db.select().from(boosterKits);
    expect(kit!.posX).toBeNull();
    const [ch] = await db.select().from(boosterKitChallenges);
    // Still live, and no progress spent, so they can perform it again where
    // they are standing.
    expect(ch!.closedAt).toBeNull();
    expect(ch!.progressIndex).toBe(0);
    expect(ch!.seenCount).toBe(0);
  });

  it("places on a retry after a positionless completing emote", async () => {
    await seedKit();
    await seedChallenge({ sequence: ["EmoteSalute"] });
    await seedEmote({ emote: "EmoteSalute", pos: null });
    await seedEmote({ emote: "EmoteSalute", pos: { x: 11, y: 22, z: 33 } });

    expect((await tick()).placed).toBe(1);
    const [kit] = await db.select().from(boosterKits);
    expect([Number(kit!.posX), Number(kit!.posY), Number(kit!.posZ)]).toEqual([11, 22, 33]);
  });

  it("ignores emotes performed before the challenge was issued", async () => {
    await seedKit();
    await seedEmote({ emote: "EmoteSalute", occurredAt: new Date("2026-09-01T00:00:00Z") });
    await seedChallenge({ sequence: ["EmoteSalute"] });

    expect((await tick()).placed).toBe(0);
    const [kit] = await db.select().from(boosterKits);
    expect(kit!.posX).toBeNull();
  });

  it("leaves an existing spot untouched when a challenge expires", async () => {
    await seedKit("1", { posX: "9", posY: "9", posZ: "9" });
    await seedChallenge({ sequence: ["EmoteSalute"], expiresAt: new Date("2026-09-19T12:00:30Z") });
    await seedEmote({ emote: "EmoteSalute" });

    await tick();

    const [kit] = await db.select().from(boosterKits);
    expect(Number(kit!.posX)).toBe(9);
    const [ch] = await db.select().from(boosterKitChallenges);
    // Expired and closed, so it stops being scanned — but the spot is intact.
    expect(ch!.closedAt).not.toBeNull();
  });

  it("holds progress on a mismatched safe emote rather than resetting", async () => {
    await seedKit();
    await seedChallenge();
    await seedEmote({ emote: "EmoteSalute" });
    await seedEmote({ emote: "EmoteDance" });
    await seedEmote({ emote: "EmoteClap" });

    expect((await tick()).placed).toBe(1);
  });

  it("ignores tokens outside the safe pool, and does not charge them", async () => {
    await seedKit();
    await seedChallenge({ sequence: ["EmoteSalute"] });
    for (let i = 0; i < MAX_POOL_EMOTES_PER_ATTEMPT + 2; i++) await seedEmote({ emote: "EmoteSitA" });
    await seedEmote({ emote: "EmoteSalute" });

    const r = await tick();
    expect(r.placed).toBe(1);
    expect(r.lockedOut).toBe(0);
  });

  it("closes the challenge when the emote budget is spent", async () => {
    await seedKit();
    await seedChallenge({ sequence: ["EmoteSalute"] });
    for (let i = 0; i < MAX_POOL_EMOTES_PER_ATTEMPT; i++) await seedEmote({ emote: "EmoteClap" });

    const r = await tick();
    expect(r.lockedOut).toBe(1);
    expect(r.placed).toBe(0);
    const [ch] = await db.select().from(boosterKitChallenges);
    expect(ch!.closedAt).not.toBeNull();
    const [kit] = await db.select().from(boosterKits);
    expect(kit!.posX).toBeNull();
  });

  it("does not re-place from events it already consumed", async () => {
    await seedKit();
    await seedChallenge({ sequence: ["EmoteSalute"] });
    await seedEmote({ emote: "EmoteSalute", pos: { x: 1, y: 2, z: 3 } });

    expect((await tick()).placed).toBe(1);
    expect((await tick()).placed).toBe(0);
    const [kit] = await db.select().from(boosterKits);
    expect([Number(kit!.posX), Number(kit!.posY), Number(kit!.posZ)]).toEqual([1, 2, 3]);
  });

  it("keeps its own cursor, distinct from the identity verifier's", async () => {
    expect(KIT_PLACEMENT_CONSUMER).not.toBe(CONSUMER);
    await seedKit();
    await seedChallenge({ sequence: ["EmoteSalute"] });
    await seedEmote({ emote: "EmoteSalute" });
    await tick();
    // ⚠️ Sharing the verifier's cursor would make each consumer skip the
    // other's events, and the symptom is silent: placement stops working.
    expect(await readCursor(db, KIT_PLACEMENT_CONSUMER)).toBeGreaterThan(0);
    expect(await readCursor(db, CONSUMER)).toBe(0);
  });
});

describe("issuePlacementChallenge", () => {
  let db: Database;
  const now = new Date("2026-09-19T12:00:00Z");

  beforeEach(async () => {
    db = createClient(URL);
    await runMigrations(db);
    await db.transaction(async (tx) => {
      await tx.execute(sql`set local client_min_messages = warning`);
      await tx.execute(sql`truncate table booster_kit_challenges, booster_kits, identity_links, consumer_cursors, events, raw_lines, adm_files, servers restart identity cascade`);
    });
  });

  const seedLink = (discordId: string, dayzId: string) =>
    db.insert(identityLinks).values({ discordId, dayzId, gamertag: "Steve", verifiedAt: now });

  it("returns null for an account with no linked character", async () => {
    expect(await issuePlacementChallenge(db, { discordId: "1", now, ttlMs: 3_600_000, rng: Math.random })).toBeNull();
  });

  it("issues a sequence bound to the linked character", async () => {
    await seedLink("1", TARGET);
    const issued = await issuePlacementChallenge(db, { discordId: "1", now, ttlMs: 3_600_000, rng: Math.random });
    expect(issued!.sequence).toHaveLength(3);
    expect(issued!.expiresAt.getTime()).toBe(now.getTime() + 3_600_000);
    const [ch] = await db.select().from(boosterKitChallenges);
    expect(ch!.targetDayzId).toBe(TARGET);
    expect(ch!.sequence).toEqual(issued!.sequence);
  });

  it("replaces a previous open challenge rather than colliding", async () => {
    await seedLink("1", TARGET);
    await issuePlacementChallenge(db, { discordId: "1", now, ttlMs: 3_600_000, rng: Math.random });
    const second = await issuePlacementChallenge(db, { discordId: "1", now, ttlMs: 3_600_000, rng: Math.random });
    expect(second).not.toBeNull();
    const open = await db.select().from(boosterKitChallenges).where(isNull(boosterKitChallenges.closedAt));
    expect(open).toHaveLength(1);
    const all = await db.select().from(boosterKitChallenges);
    expect(all).toHaveLength(2);
  });

  it("does not touch another account's open challenge", async () => {
    await seedLink("1", TARGET);
    await seedLink("2", IMPOSTOR);
    await issuePlacementChallenge(db, { discordId: "2", now, ttlMs: 3_600_000, rng: Math.random });
    await issuePlacementChallenge(db, { discordId: "1", now, ttlMs: 3_600_000, rng: Math.random });
    const open = await db.select().from(boosterKitChallenges).where(isNull(boosterKitChallenges.closedAt));
    expect(open).toHaveLength(2);
  });
});
