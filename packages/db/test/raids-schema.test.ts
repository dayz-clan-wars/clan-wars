import { describe, it, expect, beforeAll } from "vitest";
import { sql } from "drizzle-orm";
import {
  createClient, runMigrations, requireTestDatabaseUrl,
  servers, factions, events, admFiles, seasons, raids, defenses,
  type Database,
} from "../src/index";

const URL = requireTestDatabaseUrl();
const now = new Date("2026-09-06T12:00:00Z");

describe("migration 0023", () => {
  let db: Database; let serverId = 0; let factionId = 0;

  beforeAll(async () => {
    db = createClient(URL);
    await runMigrations(db);
    await db.transaction(async (tx) => {
      await tx.execute(sql`set local client_min_messages = warning`);
      await tx.execute(sql`truncate table war_log_events, clan_notices, defenses, raids, season_standings, seasons, faction_events, factions, servers restart identity cascade`);
    });
    const [s] = await db.insert(servers).values({ name: "S", map: "livonia", clockOffsetMs: 0 }).returning();
    serverId = s!.id;
    const [f] = await db.insert(factions).values({
      serverId, name: "Bears", tag: "BEAR", texture: "Flag_Bear", status: "active",
      leaderDiscordId: "d1", createdAt: now,
    }).returning();
    factionId = f!.id;
  });

  it("the queue tables refuse a coordinate in the payload", async () => {
    await expect(db.execute(sql`insert into war_log_events (server_id, kind, occurred_at, payload) values (${serverId}, 'raid', now(), '{"x": 1}')`)).rejects.toThrow(/no_coordinates/u);
    // ⚠️ A dm row must ALSO satisfy clan_notices_dm_has_target, so this row
    // supplies a discord_target_id — the assertion is about no_coordinates,
    // not about the dm/target invariant (that's the next test).
    await expect(db.execute(sql`insert into clan_notices (server_id, target, discord_target_id, kind, occurred_at, payload) values (${serverId}, 'dm', 'discord-user-1', 'kicked', now(), '{"poleKey": "1:2:3"}')`)).rejects.toThrow(/no_coordinates/u);
  });

  it("a dm notice without a discord_target_id is rejected", async () => {
    await expect(db.execute(sql`insert into clan_notices (server_id, target, kind, occurred_at, payload) values (${serverId}, 'dm', 'kicked', now(), '{}')`)).rejects.toThrow(/dm_has_target/u);
  });

  it("one open season per server", async () => {
    await db.execute(sql`insert into seasons (server_id, number, started_at) values (${serverId}, 1, now())`);
    await expect(db.execute(sql`insert into seasons (server_id, number, started_at) values (${serverId}, 2, now())`)).rejects.toThrow();
  });

  it("dormant_reason is constrained and faction_events accepts lapsed", async () => {
    await expect(db.execute(sql`update factions set dormant_reason = 'bored' where id = ${factionId}`)).rejects.toThrow(/dormant_reason/u);
    await db.execute(sql`insert into faction_events (server_id, faction_id, kind, occurred_at, payload) values (${serverId}, ${factionId}, 'lapsed', now(), '{"name":"Bears","tag":"BEAR","texture":"Flag_Bear"}')`);
  });

  it("a raid's first lower event is unique, and a defense's event too", async () => {
    const [adm] = await db.insert(admFiles).values({
      serverId, filename: "raids-schema.ADM", bootAt: now, linesIngested: 0, complete: true,
    }).returning();
    const [ev1] = await db.insert(events).values({
      serverId, admFileId: adm!.id, lineIndex: 0, type: "flag.lowered", occurredAt: now,
      payload: { dayzId: "RAIDER1" },
    }).returning();
    const [ev2] = await db.insert(events).values({
      serverId, admFileId: adm!.id, lineIndex: 1, type: "flag.raised", occurredAt: now,
      payload: { dayzId: "MEMBER1" },
    }).returning();
    const [season] = await db.select().from(seasons).where(sql`${seasons.serverId} = ${serverId}`);

    await db.insert(raids).values({
      seasonId: season!.id, serverId, victimFactionId: factionId,
      raiderDayzId: "RAIDER1", firstLowerEventId: ev1!.id,
      firstLowerAt: now, lastLowerAt: now, points: 150,
      rankedCountAtLower: 1, weekStart: now,
    });
    await expect(db.insert(raids).values({
      seasonId: season!.id, serverId, victimFactionId: factionId,
      raiderDayzId: "RAIDER1", firstLowerEventId: ev1!.id,
      firstLowerAt: now, lastLowerAt: now, points: 150,
      rankedCountAtLower: 1, weekStart: now,
    })).rejects.toThrow(/raids_first_lower_uniq/u);

    await db.insert(defenses).values({
      factionId, seasonId: season!.id, raisedByDayzId: "MEMBER1",
      eventId: ev2!.id, flagDownSince: now, defendedAt: now, siegeSeconds: 3600,
    });
    await expect(db.insert(defenses).values({
      factionId, seasonId: season!.id, raisedByDayzId: "MEMBER1",
      eventId: ev2!.id, flagDownSince: now, defendedAt: now, siegeSeconds: 3600,
    })).rejects.toThrow(/defenses_event_uniq/u);
  });
});
