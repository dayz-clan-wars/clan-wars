import { describe, it, expect, beforeEach } from "vitest";
import {
  createClient, runMigrations, requireTestDatabaseUrl,
  servers, factions, factionMembers, events, admFiles, alphaWeeks,
  raids, seasonStandings, warLogEvents, clanNotices, membershipHistory, playerSessions,
  type Database,
} from "@factions/db";
import { clanValue, raidPoints, scoringWeekStartOf, type RaidFact } from "@factions/domain";
import { asc, eq, sql } from "drizzle-orm";
import { rescoreSeason } from "../src/rescore.js";
import { rebuildStandings } from "../src/standings.js";
import { seedFaction, seedSeason } from "./seed.js";

const URL = requireTestDatabaseUrl();
const t0 = new Date("2026-10-20T12:00:00Z");
// ⚠️ Activated well over NEW_CLAN_WORTHLESS_MS before t0: a clan worth 0
// would make every points assertion below trivially 0.
const established = new Date(t0.getTime() - 30 * 86_400_000);
const H = 3_600_000;
const at = (ms: number) => new Date(t0.getTime() + ms);
/** A deliberately wrong week_start, so a rewrite of it cannot pass unnoticed. */
const OLD_WEEK = new Date("2026-10-19T00:00:00Z");

describe("rescoreSeason", () => {
  let db: Database;
  let serverId = 0;
  let admFileId = 0;
  let line = 0;
  let seasonId = 0;
  let A = 0, B = 0, C = 0, D = 0;
  const A1 = "A1-DAYZID", B1 = "B1-DAYZID", C1 = "C1-DAYZID", D1 = "D1-DAYZID";
  const PA = "1000.00:100.00:1000.00";
  const PB = "2000.00:100.00:2000.00";
  const PC = "3000.00:100.00:3000.00";
  const PD = "4000.00:100.00:4000.00";
  const PU = "7000.00:100.00:7000.00"; // nobody's declared base
  const PU2 = "7500.00:100.00:7500.00";

  const ev = async (type: "flag.raised" | "flag.lowered", dayzId: string, texture: string, poleKey: string, when: Date) => {
    const [e] = await db.insert(events).values({
      serverId, admFileId, lineIndex: line++, type, occurredAt: when,
      payload: { dayzId, gamertag: `gt-${dayzId}`, texture, poleKey, pole: { x: 1, y: 2, z: 3 } },
    }).returning();
    return e!;
  };
  /** An existing raid row, as the old consumer wrote it: a wrong price, no online flag. */
  const raidRow = async (raider: number, raiderDayz: string, victim: number, lowerId: number, when: Date) => {
    const [r] = await db.insert(raids).values({
      seasonId, serverId, victimFactionId: victim, raiderDayzId: raiderDayz, raiderFactionId: raider,
      firstLowerEventId: lowerId, firstLowerAt: when, lastLowerAt: when, lastLowerEventId: lowerId, lowerCount: 1,
      points: 999, victimOnline: false, away: false, victimRankAtLower: 1, rankedCountAtLower: 4, weekStart: OLD_WEEK,
    }).returning();
    return r!;
  };
  const snapshot = async () => ({
    raids: await db.select().from(raids).orderBy(asc(raids.id)),
    standings: await db.select().from(seasonStandings).orderBy(asc(seasonStandings.factionId)),
    alpha: await db.select().from(alphaWeeks).orderBy(asc(alphaWeeks.id)),
  });

  beforeEach(async () => {
    db = createClient(URL);
    await runMigrations(db);
    await db.transaction(async (tx) => {
      await tx.execute(sql`set local client_min_messages = warning`);
      await tx.execute(sql`truncate table clan_notices, war_log_events, alpha_weeks, season_standings, raids, seasons, membership_history, player_sessions, faction_members, declarations, poles, consumer_cursors, events, adm_files, factions, servers restart identity cascade`);
    });
    const [s] = await db.insert(servers).values({ name: "S", map: "livonia", clockOffsetMs: 0 }).returning();
    serverId = s!.id;
    const [a] = await db.insert(admFiles).values({ serverId, filename: "f.ADM", bootAt: established, linesIngested: 0, complete: true }).returning();
    admFileId = a!.id;
    line = 0;
    seasonId = (await seedSeason(db, serverId, established)).id;
    A = (await seedFaction(db, { serverId, tag: "A", texture: "Flag_A", poleKey: PA, x: 1000, z: 1000, createdAt: established, activatedAt: established })).id;
    B = (await seedFaction(db, { serverId, tag: "B", texture: "Flag_B", poleKey: PB, x: 2000, z: 2000, createdAt: established, activatedAt: established })).id;
    C = (await seedFaction(db, { serverId, tag: "C", texture: "Flag_C", poleKey: PC, x: 3000, z: 3000, createdAt: established, activatedAt: established })).id;
    // D is dormant TODAY: the replay must still accept it as a victim, because
    // nothing records what its status was at the lower.
    D = (await seedFaction(db, { serverId, tag: "D", texture: "Flag_D", poleKey: PD, x: 4000, z: 4000, status: "dormant", createdAt: established, activatedAt: established })).id;
    for (const [f, d] of [[A, A1], [B, B1], [C, C1], [D, D1]] as const) {
      await db.insert(factionMembers).values({ factionId: f, serverId, dayzId: d, discordId: `d${d}`, role: "leader", joinedAt: established, status: "full" });
      await db.insert(membershipHistory).values({ serverId, factionId: f, dayzId: d, joinedAt: established });
    }

    // Three existing base raids: A→B, B→C, C→B (B online for the last).
    await raidRow(A, A1, B, (await ev("flag.lowered", A1, "Flag_B", PB, t0)).id, t0);
    await raidRow(B, B1, C, (await ev("flag.lowered", B1, "Flag_C", PC, at(2 * H))).id, at(2 * H));
    await raidRow(C, C1, B, (await ev("flag.lowered", C1, "Flag_B", PB, at(4 * H))).id, at(4 * H));
    const conn = await ev("flag.raised", B1, "Flag_White", PU2, at(3 * H)); // any event id will do as the connect event
    await db.insert(playerSessions).values({ serverId, dayzId: B1, connectedAt: at(3 * H), connectEventId: conn.id, disconnectedAt: at(5 * H), closeReason: "disconnect" });

    // An old-flag raid nobody scored: D's own flag at an undeclared pole,
    // lowered by A, then a second of D's flags lowered by A inside 24 h
    // (absorbed into the same retro row).
    await ev("flag.raised", D1, "Flag_D", PU, at(-H));
    await ev("flag.lowered", A1, "Flag_D", PU, at(6 * H));
    await ev("flag.raised", D1, "Flag_D", PU2, at(7 * H));
    await ev("flag.lowered", A1, "Flag_D", PU2, at(8 * H));

    await db.insert(seasonStandings).values([
      { seasonId, factionId: A, points: 999, raids: 1, timesRaided: 0 },
      { seasonId, factionId: B, points: 999, raids: 1, timesRaided: 2 },
      { seasonId, factionId: C, points: 999, raids: 1, timesRaided: 1 },
    ]);
    await db.insert(alphaWeeks).values({ seasonId, weekStart: OLD_WEEK, rank: 1, factionId: A, points: 999 });
  });

  /** The independent price: every row's value from the final facts, excluding its own id. */
  const expectedPoints = async () => {
    const rows = await db.select().from(raids).orderBy(asc(raids.firstLowerAt), asc(raids.id));
    const facts: RaidFact[] = rows.map((r) => ({ id: r.id, at: r.firstLowerAt, raiderFactionId: r.raiderFactionId, victimFactionId: r.victimFactionId }));
    return rows.map((r) => ({ id: r.id, points: raidPoints(clanValue({ id: r.victimFactionId, activatedAt: established }, facts, r.firstLowerAt, r.id), r.victimOnline) }));
  };

  it("a dry run writes nothing and reports the one retro insert and the new points", async () => {
    const before = await snapshot();
    const report = await rescoreSeason(db, seasonId, { apply: false });
    expect(await snapshot()).toEqual(before);
    expect(report.inserted).toHaveLength(1);
    expect(report.inserted[0]).toMatchObject({ at: at(6 * H), raider: "A", victim: "D", away: true, online: false, lowerCount: 2, points: 75 });
    expect(report.rows.map((r) => [r.raider, r.victim, r.online, r.oldPoints, r.newPoints])).toEqual([
      ["A", "B", false, 999, 75], // B worth 100, offline
      ["B", "C", false, 999, 75],
      // B: heat from its raid 2 h earlier, halved by the hit 4 h earlier, online.
      ["C", "B", true, 999, raidPoints((100 + 50 * (1 - (2 * H) / (14 * 24 * H))) * (0.5 + (0.5 * 4) / (7 * 24)), true)],
      ["A", "D", false, 0, 75],
    ]);
    expect(report.disagreements).toEqual([]);
  });

  it("apply inserts the retro row, rewrites points/online in order, and leaves weeks, alphas and queues alone", async () => {
    const report = await rescoreSeason(db, seasonId, { apply: true });
    const rows = await db.select().from(raids).orderBy(asc(raids.id));
    expect(rows).toHaveLength(4);
    const retro = rows[3]!;
    expect(retro).toMatchObject({
      victimFactionId: D, raiderFactionId: A, raiderDayzId: A1, away: true, lowerCount: 2,
      firstLowerAt: at(6 * H), lastLowerAt: at(8 * H), weekStart: scoringWeekStartOf(at(6 * H)),
      victimRankAtLower: null, rankedCountAtLower: null,
    });
    expect(rows.slice(0, 3).map((r) => r.weekStart)).toEqual([OLD_WEEK, OLD_WEEK, OLD_WEEK]);
    expect(rows.map((r) => r.victimOnline)).toEqual([false, false, true, false]);
    expect(rows.map((r) => ({ id: r.id, points: r.points }))).toEqual(await expectedPoints());
    expect(report.rows.map((r) => r.newPoints)).toEqual(rows.map((r) => r.points));
    expect(await db.select().from(warLogEvents)).toEqual([]);
    expect(await db.select().from(clanNotices)).toEqual([]);
    expect(await db.select().from(alphaWeeks)).toEqual([{ id: expect.any(Number), seasonId, weekStart: OLD_WEEK, rank: 1, factionId: A, points: 999 }]);

    const standings = await db.select().from(seasonStandings).orderBy(asc(seasonStandings.factionId));
    await rebuildStandings(db, seasonId);
    expect(await db.select().from(seasonStandings).orderBy(asc(seasonStandings.factionId))).toEqual(standings);
    expect(standings.find((s) => s.factionId === A)).toMatchObject({ points: 150, raids: 2 });
    expect(standings.find((s) => s.factionId === D)).toMatchObject({ points: 0, timesRaided: 1 });
  });

  it("prices by the raider status recorded on the row, never the clan's status today", async () => {
    const rows = await db.select().from(raids).orderBy(asc(raids.id));
    const [ab, bc, cb] = rows;
    // B was dormant when it raided C: that row pays 0. C raided B while active
    // and is dormant today: that row still pays. A's row predates the rule
    // (null status) and keeps the old pricing.
    await db.update(raids).set({ raiderStatus: "dormant" }).where(eq(raids.id, bc!.id));
    await db.update(raids).set({ raiderStatus: "active" }).where(eq(raids.id, cb!.id));
    await db.update(factions).set({ status: "dormant" }).where(eq(factions.id, C));
    await rescoreSeason(db, seasonId, { apply: true });
    const expected = new Map((await expectedPoints()).map((e) => [e.id, e.points]));
    const after = new Map((await db.select().from(raids)).map((r) => [r.id, r.points]));
    expect(after.get(bc!.id)).toBe(0);
    expect(after.get(cb!.id)).toBe(expected.get(cb!.id));
    expect(after.get(cb!.id)).toBeGreaterThan(0);
    expect(after.get(ab!.id)).toBe(expected.get(ab!.id));
    const [bStanding] = await db.select().from(seasonStandings).where(eq(seasonStandings.factionId, B));
    expect(bStanding!.points).toBe(0);
  });

  it("re-running apply is a no-op", async () => {
    await rescoreSeason(db, seasonId, { apply: true });
    const first = await snapshot();
    const again = await rescoreSeason(db, seasonId, { apply: true });
    expect(again.inserted).toEqual([]);
    expect(again.disagreements).toEqual([]);
    expect(await snapshot()).toEqual(first);
  });

  it("reports a row the replay would not call a raid, and an unscored base raid, without changing or inserting either", async () => {
    // A row whose first lower is C's own member lowering C's flag (upkeep).
    const upkeep = await ev("flag.lowered", C1, "Flag_C", PC, at(30 * H));
    await raidRow(A, A1, C, upkeep.id, at(30 * H));
    // D lowering B's flag at B's base with no row: a base raid the old consumer
    // refused. Base raids are never inserted retroactively, only reported.
    await ev("flag.lowered", D1, "Flag_B", PB, at(40 * H));
    const report = await rescoreSeason(db, seasonId, { apply: true });
    expect(report.inserted).toHaveLength(1); // still only the old-flag raid
    expect(report.disagreements).toHaveLength(2);
    expect(report.disagreements[0]).toContain(at(30 * H).toISOString());
    expect(report.disagreements[0]).toContain(`gt-${C1}`);
    expect(report.disagreements[0]).toContain("Flag_C");
    expect(report.disagreements[0]).toMatch(/recorded A→C.*classified none/u);
    expect(report.disagreements[1]).toContain(at(40 * H).toISOString());
    expect(report.disagreements[1]).toContain(`gt-${D1}`);
    expect(report.disagreements[1]).toMatch(/recorded no raid row.*classified D→B at base/u);
    const kept = await db.select().from(raids).where(eq(raids.firstLowerEventId, upkeep.id));
    expect(kept).toHaveLength(1);
  });

  it("two raids on one victim at the same instant: the later id sees the earlier as a hit (excludeRaidId = own id)", async () => {
    const T = at(100 * H);
    const r1 = await raidRow(A, A1, C, (await ev("flag.lowered", A1, "Flag_C", PC, T)).id, T);
    const r2 = await raidRow(B, B1, C, (await ev("flag.lowered", B1, "Flag_C", PC, T)).id, T);
    const report = await rescoreSeason(db, seasonId, { apply: false });
    const price = (id: number) => report.rows.find((r) => r.id === id)!.newPoints;
    // C's value at T: base + heat from its raid on B at +4 h, halved by B's hit at +2 h fading.
    const heat = 50 * (1 - (T.getTime() - at(4 * H).getTime()) / (14 * 24 * H));
    const fade = 0.5 + (0.5 * (T.getTime() - at(2 * H).getTime())) / (7 * 24 * H);
    expect(price(r1.id)).toBe(raidPoints((100 + heat) * fade, false));
    expect(price(r2.id)).toBe(raidPoints((100 + heat) * fade * 0.5, false));
  });

  it("a retro raid inside 24 h of an existing row for the same raider and victim is deduped, not inserted or reported", async () => {
    // A existing row A→D at base 2 h after the old-flag lower: the retro lower
    // would make A raid D twice in a day.
    await raidRow(A, A1, D, (await ev("flag.lowered", A1, "Flag_D", PD, at(10 * H))).id, at(10 * H));
    const report = await rescoreSeason(db, seasonId, { apply: true });
    expect(report.inserted).toEqual([]);
    expect(report.disagreements).toEqual([]);
  });
});
