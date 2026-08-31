import { describe, it, expect, beforeEach } from "vitest";
import { createClient, runMigrations, requireTestDatabaseUrl, servers, admFiles, events, identityLinks, factions, ceremonies, whiteRaises, type Database } from "@factions/db";
import { sql, eq } from "drizzle-orm";
import { PgCeremonyStore } from "../src/ceremony-store.js";

const URL = requireTestDatabaseUrl();
const UID_A = "A".repeat(40);
const UID_B = "B".repeat(40);
const POLE = "1:2:3";
const now = new Date("2026-08-31T12:00:00Z");

describe("PgCeremonyStore", () => {
  let db: Database;
  let store: PgCeremonyStore;
  let serverId = 0;
  let admFileId = 0;
  let line = 0;

  beforeEach(async () => {
    db = createClient(URL);
    await runMigrations(db);
    await db.execute(sql`truncate table ceremony_participants, ceremonies, white_raises, faction_members, claim_drafts, factions, identity_links, events, raw_lines, adm_files, servers restart identity cascade`);
    store = new PgCeremonyStore(db);
    const [s] = await db.insert(servers).values({ name: "S", map: "sakhal", clockOffsetMs: 0 }).returning();
    serverId = s!.id;
    const [f] = await db.insert(admFiles).values({ serverId, filename: "f.ADM", bootAt: now }).returning();
    admFileId = f!.id;
    line = 0;
  });

  const event = async (occurredAt: Date) => {
    const [e] = await db.insert(events).values({
      serverId, admFileId, lineIndex: line++, subIndex: 0,
      type: "flag.raised", occurredAt, payload: {},
    }).returning();
    return e!.id;
  };

  const record = async (dayzId: string, minutes: number) => {
    const occurredAt = new Date(now.getTime() + minutes * 60_000);
    await store.recordRaise({ serverId, poleKey: POLE, dayzId, gamertag: "Steve", occurredAt, eventId: await event(occurredAt) });
  };

  it("reports the newest ingested event time as the high-water mark", async () => {
    await event(now);
    await event(new Date(now.getTime() + 900_000));
    expect(await store.highWaterMark(serverId)).toEqual(new Date(now.getTime() + 900_000));
  });

  it("reports no high-water mark for a server with no events", async () => {
    const [s2] = await db.insert(servers).values({ name: "S2", map: "livonia", clockOffsetMs: 0 }).returning();
    expect(await store.highWaterMark(s2!.id)).toBeNull();
  });

  it("records a raise once, however many times it is replayed", async () => {
    // The detector re-reads events after a crash; a raise counted twice would
    // let one player stand in for two participants.
    const occurredAt = now;
    const eventId = await event(occurredAt);
    const r = { serverId, poleKey: POLE, dayzId: UID_A, gamertag: "Steve", occurredAt, eventId };
    await store.recordRaise(r);
    await store.recordRaise(r);
    expect(await db.select().from(whiteRaises)).toHaveLength(1);
  });

  it("finds a pole bound to a faction in a holding status", async () => {
    await db.insert(factions).values({
      serverId, name: "N", tag: "N", texture: "Flag_Bear", poleKey: POLE,
      x: "1.00", y: "2.00", z: "3.00", status: "active",
      leaderDiscordId: "100", createdAt: now,
    });
    expect(await store.isPoleBound({ serverId, poleKey: POLE })).toBe(true);
  });

  it("does not treat a disbanded faction's pole as bound", async () => {
    await db.insert(factions).values({
      serverId, name: "N", tag: "N", texture: "Flag_Bear", poleKey: POLE,
      x: "1.00", y: "2.00", z: "3.00", status: "disbanded",
      leaderDiscordId: "100", createdAt: now,
    });
    expect(await store.isPoleBound({ serverId, poleKey: POLE })).toBe(false);
  });

  it("resolves a linked UID to its Discord account", async () => {
    await db.insert(identityLinks).values({ discordId: "100", dayzId: UID_A, gamertag: "Steve", verifiedAt: now });
    expect(await store.linkedDiscordId(UID_A)).toBe("100");
    expect(await store.linkedDiscordId(UID_B)).toBeNull();
  });

  it("lists poles with unsettled raises", async () => {
    await record(UID_A, 0);
    expect(await store.polesWithPendingRaises()).toEqual([{ serverId, poleKey: POLE }]);
  });

  it("marks raises settled and creates the ceremony in one transaction", async () => {
    await record(UID_A, 0);
    await record(UID_B, 1);
    const p = { serverId, poleKey: POLE };
    const raises = await store.pendingRaises(p);
    const window = { start: now, end: new Date(now.getTime() + 600_000), raises, participants: [UID_A, UID_B] };
    const id = await store.settle(p, window, {
      detectedAt: now, expiresAt: new Date(now.getTime() + 86_400_000),
      participants: [
        { dayzId: UID_A, discordId: "100", gamertag: "Steve" },
        { dayzId: UID_B, discordId: "200", gamertag: "Bob" },
      ],
    });
    expect(id).not.toBeNull();
    expect(await store.pendingRaises(p)).toHaveLength(0);
    expect(await store.hasOpenCeremony(p)).toBe(true);
  });

  it("consumes the raises of a window that produced no ceremony", async () => {
    // A window that fell short must not be re-settled forever, and its raises
    // must not leak into the next window — that is what makes windows
    // non-overlapping in the database as well as in the pure function.
    await record(UID_A, 0);
    const p = { serverId, poleKey: POLE };
    const raises = await store.pendingRaises(p);
    const window = { start: now, end: new Date(now.getTime() + 600_000), raises, participants: [UID_A] };
    expect(await store.settle(p, window, null)).toBeNull();
    expect(await store.pendingRaises(p)).toHaveLength(0);
    expect(await db.select().from(ceremonies)).toHaveLength(0);
  });
});
