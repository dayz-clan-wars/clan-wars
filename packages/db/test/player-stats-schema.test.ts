import { describe, it, expect, beforeAll } from "vitest";
import { sql, eq } from "drizzle-orm";
import {
  createClient, runMigrations, requireTestDatabaseUrl,
  servers, factions, admFiles, events, playerSessions, kills, membershipHistory, type Database,
} from "../src/index";

const URL = requireTestDatabaseUrl();
const now = new Date("2026-09-07T12:00:00Z");
const later = new Date("2026-09-07T13:00:00Z");
const UID = "A".repeat(40);

describe("migration 0026", () => {
  let db: Database; let serverId = 0; let factionId = 0; let admFileId = 0; let eventId = 0; let nextLine = 0;

  const nextEvent = async () => {
    const [ev] = await db.insert(events).values({
      serverId, admFileId, lineIndex: nextLine++, type: "player.position", occurredAt: now,
      payload: { dayzId: UID, gamertag: "A" },
    }).returning();
    return ev!.id;
  };

  beforeAll(async () => {
    db = createClient(URL);
    await runMigrations(db);
    await db.transaction(async (tx) => {
      await tx.execute(sql`set local client_min_messages = warning`);
      await tx.execute(sql`truncate table player_sessions, kills, membership_history, events, adm_files, factions, servers restart identity cascade`);
    });
    const [s] = await db.insert(servers).values({ name: "S", map: "livonia", clockOffsetMs: 0 }).returning();
    serverId = s!.id;
    const [f] = await db.insert(factions).values({ serverId, name: "Bears", tag: "BEAR", texture: "Flag_Bear", status: "active", leaderDiscordId: "d1", createdAt: now }).returning();
    factionId = f!.id;
    const [a] = await db.insert(admFiles).values({ serverId, filename: "f.ADM", bootAt: now, linesIngested: 0, complete: true }).returning();
    admFileId = a!.id;
    eventId = await nextEvent();
  });

  it("player_sessions allows only one open session per (server, player), but multiple closed ones", async () => {
    await db.insert(playerSessions).values({ serverId, dayzId: UID, connectedAt: now, connectEventId: eventId });
    const ev2 = await nextEvent();
    await expect(db.insert(playerSessions).values({ serverId, dayzId: UID, connectedAt: now, connectEventId: ev2 })).rejects.toThrow(/player_sessions_open_uniq/u);

    await db.update(playerSessions).set({ disconnectedAt: later, closeReason: "disconnect" }).where(eq(playerSessions.connectEventId, eventId));
    await db.insert(playerSessions).values({ serverId, dayzId: UID, connectedAt: later, connectEventId: ev2, disconnectedAt: later, closeReason: "disconnect" });
  });

  it("player_sessions enforces disconnected_at iff close_reason, and a valid close_reason vocabulary", async () => {
    const ev3 = await nextEvent();
    await expect(db.insert(playerSessions).values({ serverId, dayzId: UID, connectedAt: now, connectEventId: ev3, disconnectedAt: later, closeReason: null })).rejects.toThrow(/player_sessions_closed_iff_reason/u);
    await expect(db.insert(playerSessions).values({ serverId, dayzId: UID, connectedAt: now, connectEventId: ev3, disconnectedAt: later, closeReason: "timeout" })).rejects.toThrow(/player_sessions_reason_valid/u);
  });

  it("kills rejects a duplicate event_id", async () => {
    const ev4 = await nextEvent();
    await db.insert(kills).values({ serverId, eventId: ev4, occurredAt: now, victimDayzId: UID, cause: "gunshot" });
    await expect(db.insert(kills).values({ serverId, eventId: ev4, occurredAt: now, victimDayzId: UID, cause: "gunshot" })).rejects.toThrow(/kills_event_uniq/u);
  });

  it("membership_history rejects a second open row for the same (faction, player) and accepts one after the first is closed", async () => {
    await db.insert(membershipHistory).values({ serverId, factionId, dayzId: UID, joinedAt: now });
    await expect(db.insert(membershipHistory).values({ serverId, factionId, dayzId: UID, joinedAt: later })).rejects.toThrow(/membership_history_open_uniq/u);

    await db.update(membershipHistory).set({ leftAt: later }).where(eq(membershipHistory.factionId, factionId));
    await db.insert(membershipHistory).values({ serverId, factionId, dayzId: UID, joinedAt: later });
  });
});

/**
 * Migration 0027: the five indexes behind the public `/players` routes.
 * Additive only — 0027 creates indexes and nothing else. Named rather than
 * inferred, because `resolvePlayer` and `upkeepRaiseCount` reach them through
 * raw `lower(...)` / `payload->>` fragments that no typecheck can pin.
 */
describe("migration 0027 — stats indexes", () => {
  let db: Database;

  beforeAll(async () => {
    db = createClient(URL);
    await runMigrations(db);
  });

  it.each([
    ["players", "players_gamertag_lower_idx"],
    ["identity_links", "identity_links_gamertag_lower_idx"],
    ["kills", "kills_victim_dayz_idx"],
    ["kills", "kills_killer_dayz_idx"],
    ["events", "events_raise_by_player_idx"],
  ])("%s has %s", async (table, indexName) => {
    const rows = await db.execute(sql`
      select indexdef from pg_indexes
      where schemaname = current_schema() and tablename = ${table} and indexname = ${indexName}`);
    expect(rows).toHaveLength(1);
  });
});
