import { describe, it, expect, beforeEach } from "vitest";
import { createClient, runMigrations, requireTestDatabaseUrl, servers, admFiles, events, playerPositions, intruderSightings, clanPins, declarations, type Database } from "@factions/db";
import { PIN_TTL_MS, POSITION_RETENTION_MS, INTRUDER_PIN_TTL_MS } from "@factions/domain";
import { sql } from "drizzle-orm";
import { reaperTick } from "../src/reaper-tick.js";
import { seedFaction } from "./seed.js";

const URL = requireTestDatabaseUrl();
const now = new Date("2026-09-07T12:00:00Z");
const ago = (ms: number) => new Date(now.getTime() - ms);
const UID = "A".repeat(40);

describe("reaperTick", () => {
  let db: Database; let serverId = 0; let factionId = 0; let declarationId = 0; let eventId = 0;
  beforeEach(async () => {
    db = createClient(URL);
    await runMigrations(db);
    await db.execute(sql`truncate table clan_pins, intruder_sightings, player_positions, declarations, poles, factions, events, raw_lines, adm_files, servers restart identity cascade`);
    const [s] = await db.insert(servers).values({ name: "S", map: "livonia", clockOffsetMs: 0 }).returning();
    serverId = s!.id;
    factionId = (await seedFaction(db, { serverId, tag: "BEAR", texture: "Flag_Bear", createdAt: ago(1000) })).id;
    const [d] = await db.select({ id: declarations.id }).from(declarations);
    declarationId = d!.id;
    const [a] = await db.insert(admFiles).values({ serverId, filename: "f.ADM", bootAt: now, linesIngested: 0, complete: true }).returning();
    const [e] = await db.insert(events).values({ serverId, admFileId: a!.id, lineIndex: 0, type: "player.position", occurredAt: now, payload: {} }).returning();
    eventId = e!.id;
  });

  it("deletes expired pins, stale positions and sightings without a fix for INTRUDER_PIN_TTL_MS; keeps the rest", async () => {
    await db.insert(clanPins).values([
      { factionId, dayzId: UID, x: "1", z: "1", icon: "loot", createdAt: ago(PIN_TTL_MS + 1), expiresAt: ago(1) },
      { factionId, dayzId: UID, x: "1", z: "1", icon: "loot", createdAt: now, expiresAt: new Date(now.getTime() + PIN_TTL_MS) },
    ]);
    await db.insert(playerPositions).values([
      { serverId, dayzId: UID, x: "1", z: "1", alt: "1", occurredAt: ago(POSITION_RETENTION_MS + 1), eventId },
    ]);
    await db.insert(intruderSightings).values([
      { declarationId, dayzId: UID, firstSeenAt: ago(INTRUDER_PIN_TTL_MS + 1), lastSeenAt: ago(INTRUDER_PIN_TTL_MS + 1), lastAlertAt: ago(INTRUDER_PIN_TTL_MS + 1), distanceM: 1, lastX: "1", lastZ: "1" },
      { declarationId, dayzId: "B".repeat(40), firstSeenAt: ago(1), lastSeenAt: ago(1), lastAlertAt: ago(1), distanceM: 1, lastX: "1", lastZ: "1" },
    ]);
    expect(await reaperTick(db, now)).toEqual({ pins: 1, positions: 1, sightings: 1 });
    expect(await db.select().from(clanPins)).toHaveLength(1);
    expect(await db.select().from(playerPositions)).toHaveLength(0);
    expect(await db.select().from(intruderSightings)).toHaveLength(1);
  });
});
