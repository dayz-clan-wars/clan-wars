import { describe, it, expect, beforeEach } from "vitest";
import { createClient, runMigrations, requireTestDatabaseUrl, whiteRaises, ceremonies, ceremonyParticipants, servers, admFiles, events, type Database } from "../src/index.js";
import { sql } from "drizzle-orm";

const URL = requireTestDatabaseUrl();
const UID_A = "A".repeat(40);
const now = new Date("2026-08-31T12:00:00Z");

describe("ceremony schema", () => {
  let db: Database;
  let serverId = 0;
  let eventId = 0;

  beforeEach(async () => {
    db = createClient(URL);
    await runMigrations(db);
    await db.execute(sql`truncate table ceremony_participants, ceremonies, white_raises, events, raw_lines, adm_files, servers restart identity cascade`);
    const [s] = await db.insert(servers).values({ name: "S", map: "sakhal", clockOffsetMs: 0 }).returning();
    serverId = s!.id;
    const [f] = await db.insert(admFiles).values({ serverId, filename: "f.ADM", bootAt: now }).returning();
    const [e] = await db.insert(events).values({
      serverId, admFileId: f!.id, lineIndex: 1, subIndex: 0,
      type: "flag.raised", occurredAt: now, payload: {},
    }).returning();
    eventId = e!.id;
  });

  const raise = (overrides: Record<string, unknown> = {}) => db.insert(whiteRaises).values({
    serverId, poleKey: "1:2:3", dayzId: UID_A, gamertag: "Steve",
    occurredAt: now, eventId, ...overrides,
  });

  it("records a qualifying raise", async () => {
    await raise();
    expect(await db.select().from(whiteRaises)).toHaveLength(1);
  });

  it("refuses to record the same event twice", async () => {
    // The detector re-reads events after a crash. Recording a raise twice
    // would let one player count as two participants in the same window.
    await raise();
    await expect(raise()).rejects.toThrow(/white_raises_event_uniq/);
  });

  const ceremony = (overrides: Record<string, unknown> = {}) => db.insert(ceremonies).values({
    serverId, poleKey: "1:2:3", windowStart: now, windowEnd: new Date(now.getTime() + 600_000),
    status: "provisional", detectedAt: now, expiresAt: new Date(now.getTime() + 86_400_000),
    x: "1.00", y: "2.00", z: "3.00",
    ...overrides,
  }).returning();

  it("allows only one provisional ceremony per pole", async () => {
    // Otherwise a pole generates a ceremony every ten minutes for as long as
    // people keep raising White on it.
    await ceremony();
    await expect(ceremony()).rejects.toThrow(/ceremonies_open_pole_uniq/);
  });

  it("allows a new ceremony at a pole whose previous one expired", async () => {
    const [first] = await ceremony();
    await db.update(ceremonies).set({ status: "expired" }).where(sql`id = ${first!.id}`);
    await expect(ceremony()).resolves.toBeDefined();
  });

  it("rejects an unknown status", async () => {
    await expect(ceremony({ status: "banana" })).rejects.toThrow(/ceremonies_status_valid/);
  });

  it("refuses a duplicate participant in one ceremony", async () => {
    const [c] = await ceremony();
    const p = { ceremonyId: c!.id, dayzId: UID_A, discordId: "100", gamertag: "Steve" };
    await db.insert(ceremonyParticipants).values(p);
    await expect(db.insert(ceremonyParticipants).values(p)).rejects.toThrow(/ceremony_participants_uniq/);
  });

  it("deletes participants with their ceremony", async () => {
    const [c] = await ceremony();
    await db.insert(ceremonyParticipants).values({ ceremonyId: c!.id, dayzId: UID_A, discordId: "100", gamertag: "Steve" });
    await db.delete(ceremonies).where(sql`id = ${c!.id}`);
    expect(await db.select().from(ceremonyParticipants)).toHaveLength(0);
  });
});
