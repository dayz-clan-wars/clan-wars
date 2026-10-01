import { describe, it, expect, beforeEach } from "vitest";
import {
  createClient, runMigrations, requireTestDatabaseUrl,
  servers, events, admFiles, feedEntries, factionEvents, clanNotices, warLogEvents, banAnnouncements, playerSessions, players, membershipHistory,
  type Database,
} from "@factions/db";
import type { LiveEntryKind } from "@factions/domain";
import { sql } from "drizzle-orm";
import { liveFeedDb, onlineNowDb } from "../src/live";
import { seedFaction } from "./seed";

const URL = requireTestDatabaseUrl();
const now = new Date("2026-09-30T12:00:00Z");

describe("roster live reads", () => {
  let db: Database;
  let serverId = 0;
  let clanId = 0;
  let admFileId = 0;
  let line = 0;

  /** Every feed_entries row cites an events row (its FK), and a session cites its connect event. */
  async function newEvent(type = "player.killed"): Promise<number> {
    const [e] = await db.insert(events).values({
      serverId, admFileId, lineIndex: line++, type, occurredAt: now, payload: {},
    } as never).returning();
    return e!.id;
  }

  async function seedEntry(kind: LiveEntryKind): Promise<number> {
    const sourceEventId = await newEvent();
    const [r] = await db.insert(feedEntries).values({
      serverId, kind, sourceEventId, occurredAt: now,
      payload: { occurredAt: now.toISOString(), killer: { gamertag: "K", tag: null, texture: null } },
    }).returning();
    return r!.id;
  }

  async function seedKills(n: number): Promise<number[]> {
    const ids: number[] = [];
    for (let i = 0; i < n; i++) ids.push(await seedEntry("kill"));
    return ids;
  }

  async function insertNotice(a: { target: "channel" | "dm"; factionId: number | null; payload: Record<string, unknown> }): Promise<void> {
    await db.insert(clanNotices).values({
      serverId, factionId: a.factionId, target: a.target, discordTargetId: a.target === "dm" ? "d1" : null,
      kind: "achievement", occurredAt: now, payload: a.payload,
    });
  }

  async function openSession(dayzId: string, gamertag: string): Promise<void> {
    await db.insert(players).values({ dayzId, gamertag, firstSeenAt: now, lastSeenAt: now });
    await db.insert(playerSessions).values({ serverId, dayzId, connectedAt: now, connectEventId: await newEvent("player.connected") });
  }

  beforeEach(async () => {
    db = createClient(URL);
    await runMigrations(db);
    await db.transaction(async (tx) => {
      await tx.execute(sql`set local client_min_messages = warning`);
      await tx.execute(sql`truncate table feed_entries, clan_notices, faction_events, war_log_events, ban_announcements, player_sessions, membership_history, faction_join_requests, identity_holds, faction_invites, roster_cooldowns, faction_members, declarations, poles, factions, ceremony_participants, ceremonies, claim_drafts, identity_links, players, events, raw_lines, adm_files, servers restart identity cascade`);
    });
    const [s] = await db.insert(servers).values({ name: "S", map: "livonia", clockOffsetMs: 0 }).returning();
    serverId = s!.id;
    line = 0;
    const f = await seedFaction(db, { serverId, tag: "BEAR", name: "Bears", texture: "Flag_Bear", createdAt: now, activatedAt: now });
    clanId = f.id;
    const [adm] = await db.insert(admFiles).values({ serverId, filename: "live.ADM", bootAt: now, linesIngested: 0, complete: true }).returning();
    admFileId = adm!.id;
  });

  it("pages newest first with before, and returns only newer rows with after", async () => {
    const ids = await seedKills(5);
    const first = await liveFeedDb(db, "kills", { limit: 2 });
    expect(first.map((r) => r.id)).toEqual([ids[4], ids[3]]);
    const older = await liveFeedDb(db, "kills", { before: ids[3], limit: 2 });
    expect(older.map((r) => r.id)).toEqual([ids[2], ids[1]]);
    const newer = await liveFeedDb(db, "kills", { after: ids[2] });
    expect(newer.map((r) => r.id)).toEqual([ids[4], ids[3]]);
  });

  it("lets after win when both are given", async () => {
    const ids = await seedKills(4);
    const rows = await liveFeedDb(db, "kills", { before: ids[1], after: ids[2] });
    expect(rows.map((r) => r.id)).toEqual([ids[3]]);
  });

  it("keeps each combat tab to its own kind", async () => {
    await seedEntry("kill"); await seedEntry("long_range");
    expect((await liveFeedDb(db, "long-range")).every((r) => r.feed === "long-range")).toBe(true);
    expect(await liveFeedDb(db, "long-range")).toHaveLength(1);
  });

  it("clamps the limit", async () => {
    await seedKills(3);
    expect(await liveFeedDb(db, "kills", { limit: 0 })).toHaveLength(1);
    expect(await liveFeedDb(db, "kills", { limit: 10_000 })).toHaveLength(3);
  });

  it("reads only the public achievement posts and never hands back a Discord id", async () => {
    await insertNotice({ target: "channel", factionId: null, payload: { key: "k", name: "N", description: "D", ownerKind: "player", ownerId: "x", ownerName: "123456789012345678", gamertag: null, clanTag: null, public: true } });
    await insertNotice({ target: "channel", factionId: clanId, payload: { key: "k", name: "N", description: "D", ownerKind: "clan", ownerName: "Wolves", public: false } });
    const rows = await liveFeedDb(db, "achievements");
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ feed: "achievements", payload: { ownerName: null } });
    expect(JSON.stringify(rows)).not.toMatch(/123456789012345678|ownerId/u);
  });

  it("lists who is online without their DayZ id", async () => {
    await openSession("A".repeat(40), "Alpha");
    const rows = await onlineNowDb(db);
    expect(rows).toEqual([{ gamertag: "Alpha", tag: null, connectedAt: expect.any(Date) }]);
  });

  it("shows the clan tag of an online member", async () => {
    await openSession("B".repeat(40), "Bravo");
    await db.insert(membershipHistory).values({ serverId, factionId: clanId, dayzId: "B".repeat(40), joinedAt: now });
    expect(await onlineNowDb(db)).toMatchObject([{ gamertag: "Bravo", tag: "BEAR" }]);
  });

  it("reads the war log from war_log_events, all four kinds", async () => {
    const kinds = ["raid", "defense", "week_closed", "season_closed"] as const;
    for (const [i, kind] of kinds.entries()) {
      await db.insert(warLogEvents).values({ serverId, kind, occurredAt: new Date(now.getTime() + i * 1000), payload: { points: i } });
    }
    const rows = await liveFeedDb(db, "war-log");
    expect(rows).toHaveLength(4);
    expect(rows.map((r) => (r.feed === "war-log" ? r.kind : null))).toEqual(["season_closed", "week_closed", "defense", "raid"]);
    expect(rows[0]).toMatchObject({ feed: "war-log", payload: { points: 3 } });
  });

  it("bans carry only gamertag, reason and expiry", async () => {
    await db.insert(banAnnouncements).values({
      serverId, kind: "applied", occurredAt: now,
      payload: { gamertag: "Griefer", reason: "zone", expiresAt: "2026-10-01T00:00:00.000Z", dayzId: "Z".repeat(40), note: "private" },
    });
    const [row] = await liveFeedDb(db, "bans");
    expect(row).toMatchObject({ feed: "bans", kind: "applied" });
    expect((row as { payload: unknown }).payload).toEqual({ gamertag: "Griefer", reason: "zone", expiresAt: "2026-10-01T00:00:00.000Z" });
    expect(JSON.stringify(row)).not.toMatch(/dayzId|private/u);
  });

  it("clans carry only the allowlisted payload keys", async () => {
    await db.insert(factionEvents).values({
      serverId, factionId: clanId, kind: "renamed", occurredAt: now,
      payload: { name: "Bears", tag: "BEAR", texture: "Flag_Bear", previousName: "Cubs", actor: 7, dayzId: "Z".repeat(40) },
    } as never);
    const [row] = await liveFeedDb(db, "clans");
    expect(row!.payload).toEqual({ name: "Bears", tag: "BEAR", texture: "Flag_Bear", previousName: "Cubs" });
  });

  it("war log carries only the keys the line reads, nulls kept", async () => {
    await db.insert(warLogEvents).values({
      serverId, kind: "season_closed", occurredAt: now,
      payload: { number: 2, clan: null, tag: null, points: null, weekStart: "x", dayzId: "Z".repeat(40) },
    });
    const [row] = await liveFeedDb(db, "war-log");
    expect(row!.payload).toEqual({ number: 2, clan: null, tag: null, points: null });
  });

  it("ignores a cursor that is not a positive safe integer", async () => {
    const ids = await seedKills(3);
    const newest = [ids[2], ids[1], ids[0]];
    expect((await liveFeedDb(db, "kills", { before: NaN })).map((r) => r.id)).toEqual(newest);
    expect((await liveFeedDb(db, "kills", { after: 1.5 })).map((r) => r.id)).toEqual(newest);
    expect((await liveFeedDb(db, "kills", { after: -1 })).map((r) => r.id)).toEqual(newest);
  });

  it("excludes everything that belongs to a server that is not the active one", async () => {
    // activeServerId takes the lowest-id server with active = true.
    const [other] = await db.insert(servers).values({ name: "T", map: "livonia", clockOffsetMs: 0, active: false }).returning();
    const otherId = other!.id;
    const [e] = await db.insert(events).values({ serverId: otherId, admFileId, lineIndex: 9999, type: "player.killed", occurredAt: now, payload: {} } as never).returning();
    await db.insert(feedEntries).values({ serverId: otherId, kind: "kill", sourceEventId: e!.id, occurredAt: now, payload: {} });
    await db.insert(clanNotices).values({
      serverId: otherId, factionId: null, target: "channel", kind: "achievement", occurredAt: now,
      payload: { key: "k", name: "N", description: "D", ownerKind: "player", ownerName: "Pat", public: true },
    });
    const [c] = await db.insert(events).values({ serverId: otherId, admFileId, lineIndex: 10000, type: "player.connected", occurredAt: now, payload: {} } as never).returning();
    await db.insert(players).values({ dayzId: "O".repeat(40), gamertag: "Other", firstSeenAt: now, lastSeenAt: now });
    await db.insert(playerSessions).values({ serverId: otherId, dayzId: "O".repeat(40), connectedAt: now, connectEventId: c!.id });
    expect(await liveFeedDb(db, "kills")).toEqual([]);
    expect(await liveFeedDb(db, "achievements")).toEqual([]);
    expect(await onlineNowDb(db)).toEqual([]);
  });
});
