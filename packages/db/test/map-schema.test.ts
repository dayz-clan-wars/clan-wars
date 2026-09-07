import { describe, it, expect, beforeAll } from "vitest";
import { sql, eq } from "drizzle-orm";
import {
  createClient, runMigrations, requireTestDatabaseUrl,
  servers, factions, admFiles, events, declarations, playerPositions, intruderSightings, clanPins, type Database,
} from "../src/index";

const URL = requireTestDatabaseUrl();
const now = new Date("2026-09-07T12:00:00Z");
const UID = "A".repeat(40);

describe("migration 0025", () => {
  let db: Database; let serverId = 0; let factionId = 0; let eventId = 0; let declarationId = 0;

  beforeAll(async () => {
    db = createClient(URL);
    await runMigrations(db);
    await db.transaction(async (tx) => {
      await tx.execute(sql`set local client_min_messages = warning`);
      await tx.execute(sql`truncate table clan_pins, intruder_sightings, player_positions, declarations, events, adm_files, factions, servers restart identity cascade`);
    });
    const [s] = await db.insert(servers).values({ name: "S", map: "livonia", clockOffsetMs: 0 }).returning();
    serverId = s!.id;
    const [f] = await db.insert(factions).values({ serverId, name: "Bears", tag: "BEAR", texture: "Flag_Bear", status: "active", leaderDiscordId: "d1", createdAt: now }).returning();
    factionId = f!.id;
    const [a] = await db.insert(admFiles).values({ serverId, filename: "f.ADM", bootAt: now, linesIngested: 0, complete: true }).returning();
    const [ev] = await db.insert(events).values({ serverId, admFileId: a!.id, lineIndex: 0, type: "player.position", occurredAt: now, payload: { dayzId: UID, gamertag: "A", pos: { x: 1, y: 2, z: 3 } } }).returning();
    eventId = ev!.id;
    const [d] = await db.insert(declarations).values({ serverId, poleKey: "5000.00:100.00:5000.00", x: "5000", y: "100", z: "5000", ownerFactionId: factionId, evidenceEventId: eventId, declaredAt: now }).returning();
    declarationId = d!.id;
  });

  it("player_positions is unique per event", async () => {
    await db.insert(playerPositions).values({ serverId, dayzId: UID, x: "1", z: "3", alt: "2", occurredAt: now, eventId });
    await expect(db.insert(playerPositions).values({ serverId, dayzId: UID, x: "1", z: "3", alt: "2", occurredAt: now, eventId })).rejects.toThrow(/player_positions_event_uniq/u);
  });

  it("intruder_sightings is unique per (declaration, player) and cascades with the declaration", async () => {
    await db.insert(intruderSightings).values({ declarationId, dayzId: UID, firstSeenAt: now, lastSeenAt: now, lastAlertAt: now, distanceM: 40, lastX: "5010", lastZ: "5030" });
    await expect(db.insert(intruderSightings).values({ declarationId, dayzId: UID, firstSeenAt: now, lastSeenAt: now, lastAlertAt: now, distanceM: 41, lastX: "5010", lastZ: "5030" })).rejects.toThrow(/intruder_sightings_uniq/u);
    await db.delete(declarations).where(eq(declarations.id, declarationId));
    expect(await db.select().from(intruderSightings)).toEqual([]);
  });

  it("clan_pins pins the icon vocabulary and cascades with the clan", async () => {
    await db.insert(clanPins).values({ factionId, dayzId: UID, x: "1", z: "2", icon: "loot", note: null, createdAt: now, expiresAt: now });
    await expect(db.insert(clanPins).values({ factionId, dayzId: UID, x: "1", z: "2", icon: "treasure", note: null, createdAt: now, expiresAt: now })).rejects.toThrow(/clan_pins_icon_valid/u);
    await db.delete(factions).where(eq(factions.id, factionId));
    expect(await db.select().from(clanPins)).toEqual([]);
  });
});
