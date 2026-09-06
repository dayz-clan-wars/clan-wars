import { describe, it, expect, beforeAll } from "vitest";
import { sql, eq } from "drizzle-orm";
import {
  createClient, runMigrations, requireTestDatabaseUrl,
  servers, factions, seasons, alphaWeeks, seasonResults,
  type Database,
} from "../src/index";

const URL = requireTestDatabaseUrl();
const now = new Date("2026-09-06T12:00:00Z");
const monday = new Date("2026-09-07T00:00:00Z");

describe("migration 0024", () => {
  let db: Database; let serverId = 0; let seasonId = 0; let A = 0; let B = 0;

  beforeAll(async () => {
    db = createClient(URL);
    await runMigrations(db);
    await db.transaction(async (tx) => {
      await tx.execute(sql`set local client_min_messages = warning`);
      await tx.execute(sql`truncate table season_results, alpha_weeks, war_log_events, clan_notices, defenses, raids, season_standings, seasons, faction_events, factions, servers restart identity cascade`);
    });
    const [s] = await db.insert(servers).values({ name: "S", map: "livonia", clockOffsetMs: 0 }).returning();
    serverId = s!.id;
    const [season] = await db.insert(seasons).values({ serverId, number: 1, startedAt: now }).returning();
    seasonId = season!.id;
    const [fa] = await db.insert(factions).values({
      serverId, name: "Bears", tag: "BEAR", texture: "Flag_Bear", status: "active",
      leaderDiscordId: "d1", createdAt: now,
    }).returning();
    A = fa!.id;
    const [fb] = await db.insert(factions).values({
      serverId, name: "Wolves", tag: "WOLF", texture: "Flag_Wolf", status: "active",
      leaderDiscordId: "d2", createdAt: now,
    }).returning();
    B = fb!.id;
  });

  it("alpha_weeks is unique per (season, week, rank) and rank is 1..3", async () => {
    await db.insert(alphaWeeks).values({ seasonId, weekStart: monday, rank: 1, factionId: A, points: 300 });
    await expect(db.insert(alphaWeeks).values({ seasonId, weekStart: monday, rank: 1, factionId: B, points: 200 })).rejects.toThrow(/alpha_weeks_uniq/u);
    await expect(db.insert(alphaWeeks).values({ seasonId, weekStart: monday, rank: 4, factionId: B, points: 1 })).rejects.toThrow(/alpha_weeks_rank_valid/u);
  });

  it("season_results is unique per (season, faction) and pins the status vocabulary", async () => {
    await db.insert(seasonResults).values({ seasonId, factionId: A, rank: 1, points: 300, raids: 2, timesRaided: 0, defenses: 1, statusAtClose: "active" });
    await expect(db.insert(seasonResults).values({ seasonId, factionId: A, rank: 2, points: 0, raids: 0, timesRaided: 0, defenses: 0, statusAtClose: "active" })).rejects.toThrow(/season_results_uniq/u);
    await expect(db.insert(seasonResults).values({ seasonId, factionId: B, rank: 2, points: 0, raids: 0, timesRaided: 0, defenses: 0, statusAtClose: "gone" })).rejects.toThrow(/season_results_status_valid/u);
  });

  it("seasons.week_closed_through starts null", async () => {
    const [s] = await db.select({ w: seasons.weekClosedThrough }).from(seasons).where(eq(seasons.id, seasonId));
    expect(s!.w).toBeNull();
  });
});
