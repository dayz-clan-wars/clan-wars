import { describe, it, expect, beforeEach } from "vitest";
import {
  createClient, runMigrations, requireTestDatabaseUrl,
  servers, factions, declarations, ceremonies, events, admFiles, type Database,
} from "../src/index.js";
import { sql } from "drizzle-orm";

const URL = requireTestDatabaseUrl();
const now = new Date("2026-09-04T12:00:00Z");

describe("declarations", () => {
  let db: Database;
  let serverId = 0;
  let ceremonyId = 0;
  let eventId = 0;
  let factionId = 0;

  beforeEach(async () => {
    db = createClient(URL);
    await runMigrations(db);
    await db.execute(sql`truncate table declarations, factions, ceremonies, events, raw_lines, adm_files, servers restart identity cascade`);
    const [s] = await db.insert(servers).values({ name: "S", map: "livonia", clockOffsetMs: 0 }).returning();
    serverId = s!.id;
    const [c] = await db.insert(ceremonies).values({
      serverId, poleKey: "1.00:2.00:3.00", x: "1.00", y: "2.00", z: "3.00",
      windowStart: now, windowEnd: now, status: "claimed", detectedAt: now, expiresAt: now,
    }).returning();
    ceremonyId = c!.id;
    const [a] = await db.insert(admFiles).values({ serverId, filename: "f.ADM", bootAt: now, linesIngested: 0, complete: true }).returning();
    const [e] = await db.insert(events).values({
      serverId, admFileId: a!.id, lineIndex: 0, type: "flag.raised", occurredAt: now,
      payload: { dayzId: "A", gamertag: "G", texture: "Flag_White", poleKey: "1.00:2.00:3.00" },
    }).returning();
    eventId = e!.id;
    const [f] = await db.insert(factions).values({
      serverId, name: "Bears", tag: "BEAR", texture: "Flag_Bear", status: "active",
      leaderDiscordId: "d1", createdAt: now,
    }).returning();
    factionId = f!.id;
  });

  const row = (o: Partial<typeof declarations.$inferInsert>) => ({
    serverId, poleKey: "1.00:2.00:3.00", x: "1.00", y: "2.00", z: "3.00", declaredAt: now, ...o,
  });

  it("accepts a clan declaration citing a ceremony", async () => {
    await db.insert(declarations).values(row({ ownerFactionId: factionId, evidenceCeremonyId: ceremonyId }));
  });

  it("accepts a solo declaration citing a raise", async () => {
    await db.insert(declarations).values(row({ ownerDayzId: "A", evidenceEventId: eventId }));
  });

  it("⚠️ refuses a row with no evidence — the site can never bind a pole from nothing", async () => {
    await expect(db.insert(declarations).values(row({ ownerDayzId: "A" }))).rejects.toThrow(/declarations_one_evidence/);
  });

  it("refuses a row with two owners or none", async () => {
    await expect(db.insert(declarations).values(row({ ownerDayzId: "A", ownerFactionId: factionId, evidenceEventId: eventId })))
      .rejects.toThrow(/declarations_one_owner/);
    await expect(db.insert(declarations).values(row({ evidenceEventId: eventId })))
      .rejects.toThrow(/declarations_one_owner/);
  });

  it("allows one declared owner per pole", async () => {
    await db.insert(declarations).values(row({ ownerDayzId: "A", evidenceEventId: eventId }));
    await expect(db.insert(declarations).values(row({ ownerDayzId: "B", evidenceEventId: eventId })))
      .rejects.toThrow(/declarations_pole_uniq/);
  });

  it("allows one base per clan and one per player", async () => {
    await db.insert(declarations).values(row({ ownerFactionId: factionId, evidenceCeremonyId: ceremonyId }));
    await expect(db.insert(declarations).values(row({ poleKey: "9.00:9.00:9.00", ownerFactionId: factionId, evidenceCeremonyId: ceremonyId })))
      .rejects.toThrow(/declarations_faction_uniq/);
    await db.insert(declarations).values(row({ poleKey: "5.00:5.00:5.00", ownerDayzId: "A", evidenceEventId: eventId }));
    await expect(db.insert(declarations).values(row({ poleKey: "6.00:6.00:6.00", ownerDayzId: "A", evidenceEventId: eventId })))
      .rejects.toThrow(/declarations_player_uniq/);
  });

  it("factions no longer carries pole columns", async () => {
    const cols = await db.execute(sql`select column_name from information_schema.columns where table_name = 'factions'`);
    const names = (cols as unknown as { column_name: string }[]).map((c) => c.column_name);
    expect(names).not.toContain("pole_key");
    expect(names).not.toContain("x");
  });

  it("poles carries grace_until", async () => {
    const cols = await db.execute(sql`select column_name from information_schema.columns where table_name = 'poles' and column_name = 'grace_until'`);
    expect(cols.length).toBe(1);
  });
});
