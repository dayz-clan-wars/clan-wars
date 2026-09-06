import { describe, it, expect, beforeEach } from "vitest";
import {
  createClient, runMigrations, requireTestDatabaseUrl,
  servers, seasons, seasonStandings, seasonResults, warLogEvents,
  type Database,
} from "@factions/db";
import { sql, eq, asc } from "drizzle-orm";
import { closeSeasonTx } from "../src/season-close.js";
import { seedFaction, seedSeason } from "./seed.js";

const URL = requireTestDatabaseUrl();
const now = new Date("2026-09-02T12:00:00Z");

describe("closeSeasonTx", () => {
  let db: Database;
  let serverId = 0;
  let seasonId = 0;
  let WOLF = 0;
  let BEAR = 0;
  let LYNX = 0;
  let OWL = 0;

  beforeEach(async () => {
    db = createClient(URL);
    await runMigrations(db);
    await db.transaction(async (tx) => {
      await tx.execute(sql`set local client_min_messages = warning`);
      await tx.execute(sql`truncate table war_log_events, season_results, season_standings, seasons, faction_members, declarations, poles, events, adm_files, factions, servers restart identity cascade`);
    });
    const [s] = await db.insert(servers).values({ name: "S", map: "livonia", clockOffsetMs: 0 }).returning();
    serverId = s!.id;

    const season = await seedSeason(db, serverId, now);
    seasonId = season.id;

    const wolf = await seedFaction(db, { serverId, tag: "WOLF", texture: "Flag_Wolf", poleKey: "1000.00:100.00:1000.00", createdAt: now, activatedAt: now, status: "active" });
    WOLF = wolf.id;
    const bear = await seedFaction(db, { serverId, tag: "BEAR", texture: "Flag_Bear", poleKey: "2000.00:100.00:2000.00", createdAt: now, activatedAt: now, status: "dormant", dormantSince: now });
    BEAR = bear.id;
    const lynx = await seedFaction(db, { serverId, tag: "LYNX", texture: "Flag_Lynx", poleKey: "3000.00:100.00:3000.00", createdAt: now, activatedAt: now, status: "active" });
    LYNX = lynx.id;
    const owl = await seedFaction(db, { serverId, tag: "OWL", texture: "Flag_Owl", poleKey: "4000.00:100.00:4000.00", createdAt: now, activatedAt: now, status: "disbanded" });
    OWL = owl.id;

    await db.insert(seasonStandings).values([
      { seasonId, factionId: WOLF, points: 300, raids: 3, timesRaided: 0, defenses: 0 },
      { seasonId, factionId: BEAR, points: 100, raids: 1, timesRaided: 2, defenses: 1 },
      { seasonId, factionId: LYNX, points: 0, raids: 0, timesRaided: 0, defenses: 0 },
      { seasonId, factionId: OWL, points: 50, raids: 1, timesRaided: 1, defenses: 0 },
    ]);
  });

  it("snapshots every standings row in §8.1 order with status_at_close, names the champion, queues the line", async () => {
    const at = new Date("2026-09-30T00:00:00Z");
    const r = await db.transaction((tx) => closeSeasonTx(tx, serverId, at));

    expect(r).toMatchObject({ number: 1, champion: { factionId: WOLF, points: 300 } });

    expect(await db.select().from(seasonResults).orderBy(asc(seasonResults.rank))).toMatchObject([
      { factionId: WOLF, rank: 1, points: 300, statusAtClose: "active" },
      { factionId: BEAR, rank: 2, points: 100, statusAtClose: "dormant" },
      { factionId: OWL, rank: 3, points: 50, statusAtClose: "disbanded" },
      { factionId: LYNX, rank: 4, points: 0, statusAtClose: "active" },
    ]);

    const [season] = await db.select().from(seasons).where(eq(seasons.id, seasonId));
    expect(season).toMatchObject({ endedAt: at, championFactionId: WOLF });

    const [line] = await db.select().from(warLogEvents);
    expect(line).toMatchObject({ kind: "season_closed", payload: { number: 1, clan: "WOLF", points: 300 } });
  });

  it("no scorer → no champion, the line says so", async () => {
    await db.update(seasonStandings).set({ points: 0 }).where(eq(seasonStandings.seasonId, seasonId));
    const at = new Date("2026-09-30T00:00:00Z");
    const r = await db.transaction((tx) => closeSeasonTx(tx, serverId, at));

    expect(r!.champion).toBeNull();
    const [season] = await db.select().from(seasons).where(eq(seasons.id, seasonId));
    expect(season!.championFactionId).toBeNull();

    const [line] = await db.select().from(warLogEvents);
    expect(line).toMatchObject({ kind: "season_closed", payload: { number: 1, clan: null, points: null } });
  });

  it("closing twice is once", async () => {
    const at = new Date("2026-09-30T00:00:00Z");
    await db.transaction((tx) => closeSeasonTx(tx, serverId, at));
    const again = await db.transaction((tx) => closeSeasonTx(tx, serverId, new Date("2026-10-01T00:00:00Z")));

    expect(again).toBeNull();
    expect(await db.select().from(seasonResults)).toHaveLength(4);
    expect(await db.select().from(warLogEvents)).toHaveLength(1);
  });
});
