import { describe, it, expect, beforeEach } from "vitest";
import {
  createClient, runMigrations, requireTestDatabaseUrl,
  servers, factions, factionMembers, declarations, events, admFiles,
  raids, seasons, seasonStandings, warLogEvents, clanNotices, membershipHistory, playerSessions,
  type Database,
} from "@factions/db";
import { RAID_DEDUP_MS, clanValue, raidPoints, scoringWeekStartOf, type RaidFact } from "@factions/domain";
import { sql, eq } from "drizzle-orm";
import { raidTick } from "../src/raid-tick.js";
import { seedFaction, seedSeason } from "./seed.js";

const URL = requireTestDatabaseUrl();
const now = new Date("2026-09-04T12:00:00Z");
// ⚠️ Activated well over NEW_CLAN_WORTHLESS_MS ago: a clan activated `now` is
// worth 0, which would make every points assertion below trivially 0.
const established = new Date(now.getTime() - 30 * 86_400_000);
/** An established clan with no raids, offline: RAID_VALUE_BASE × RAID_OFFLINE_MULT. */
const BASE_OFFLINE = raidPoints(clanValue({ id: 0, activatedAt: established }, [], now), false);

describe("raidTick", () => {
  let db: Database;
  let serverId = 0;
  let admFileId = 0;
  let lineIndex = 0;
  let BEAR = 0;
  let WOLF = 0;
  const B1 = "B1-DAYZID-0000000000000000000000000";
  const W1 = "W1-DAYZID-0000000000000000000000000";
  const S1 = "S1-DAYZID-0000000000000000000000000";
  const P1 = "1000.00:100.00:1000.00";
  const P2 = "2000.00:100.00:2000.00";

  beforeEach(async () => {
    db = createClient(URL);
    await runMigrations(db);
    await db.transaction(async (tx) => {
      await tx.execute(sql`set local client_min_messages = warning`);
      await tx.execute(sql`truncate table clan_notices, war_log_events, season_standings, raids, seasons, faction_members, declarations, poles, consumer_cursors, events, adm_files, factions, servers restart identity cascade`);
    });
    const [s] = await db.insert(servers).values({ name: "S", map: "livonia", clockOffsetMs: 0 }).returning();
    serverId = s!.id;
    const [a] = await db.insert(admFiles).values({ serverId, filename: "f.ADM", bootAt: now, linesIngested: 0, complete: true }).returning();
    admFileId = a!.id;
    lineIndex = 0;

    await seedSeason(db, serverId, now);

    const bear = await seedFaction(db, { serverId, tag: "BEAR", texture: "Flag_Bear", poleKey: P1, createdAt: established, activatedAt: established });
    BEAR = bear.id;
    const wolf = await seedFaction(db, { serverId, tag: "WOLF", texture: "Flag_Wolf", poleKey: P2, createdAt: established, activatedAt: established });
    WOLF = wolf.id;

    await db.insert(factionMembers).values([
      { factionId: BEAR, serverId, dayzId: B1, discordId: "dB1", role: "leader", joinedAt: now, status: "full" },
      { factionId: WOLF, serverId, dayzId: W1, discordId: "dW1", role: "leader", joinedAt: now, status: "full" },
    ]);
    await db.insert(membershipHistory).values([
      { serverId, factionId: BEAR, dayzId: B1, joinedAt: established },
      { serverId, factionId: WOLF, dayzId: W1, joinedAt: established },
    ]);
  });

  const lower = (dayzId: string, gamertag: string, texture: string, poleKey: string, at: Date) =>
    db.insert(events).values({
      serverId, admFileId, lineIndex: lineIndex++, type: "flag.lowered", occurredAt: at,
      payload: { dayzId, gamertag, texture, poleKey, pole: { x: 1, y: 2, z: 3 } },
    });

  const declareSolo = async (poleKey: string, dayzId: string) => {
    const [ev] = await db.insert(events).values({
      serverId, admFileId, lineIndex: lineIndex++, type: "flag.raised", occurredAt: now,
      payload: { dayzId, gamertag: "Solo", texture: "Flag_White", poleKey, pole: { x: 1, y: 2, z: 3 } },
    }).returning();
    await db.insert(declarations).values({
      serverId, poleKey, x: "1.00", y: "2.00", z: "3.00", ownerDayzId: dayzId, evidenceEventId: ev!.id, declaredAt: now,
    });
  };

  it("a non-member lowering an active clan's flag at its declared pole is a raid: row, standings, flag_down, war-log, notices", async () => {
    await lower(W1, "Wolfie", "Flag_Bear", P1, now);
    const r = await raidTick(db);
    expect(r).toMatchObject({ raids: 1, absorbed: 0 });
    const [raid] = await db.select().from(raids);
    expect(raid).toMatchObject({
      victimFactionId: BEAR, raiderFactionId: WOLF, raiderDayzId: W1,
      lowerCount: 1, points: BASE_OFFLINE, victimRankAtLower: null, rankedCountAtLower: 0,
      victimOnline: false, away: false,
    });
    expect(raid!.weekStart.toISOString()).toBe(scoringWeekStartOf(now).toISOString());
    const [bear] = await db.select({ f: factions.flagDownSince, by: factions.flagDownByDayzId }).from(factions).where(eq(factions.id, BEAR));
    expect(bear).toEqual({ f: now, by: W1 });
    const standings = await db.select().from(seasonStandings).orderBy(seasonStandings.factionId);
    expect(standings.map((s) => [s.factionId, s.points, s.raids, s.timesRaided])).toEqual([[BEAR, 0, 0, 1], [WOLF, BASE_OFFLINE, 1, 0]]);
    const [log] = await db.select().from(warLogEvents);
    expect(log).toMatchObject({ kind: "raid", payload: { raiderClan: "WOLF", victimClan: "BEAR", gamertag: "Wolfie", solo: false, points: BASE_OFFLINE } });
    const notices = await db.select({ target: clanNotices.target, kind: clanNotices.kind, to: clanNotices.discordTargetId }).from(clanNotices);
    expect(notices).toEqual(expect.arrayContaining([
      { target: "channel", kind: "flag_down", to: null },
      { target: "dm", kind: "flag_down", to: "dB1" },
    ]));
  });

  it("a second lower by the same clan inside 24 h is absorbed; a different clan's is a new raid", async () => {
    await lower(W1, "Wolfie", "Flag_Bear", P1, now);
    await lower(W1, "Wolfie", "Flag_Bear", P1, new Date(now.getTime() + 3_600_000));
    await lower(S1, "Solo", "Flag_Bear", P1, new Date(now.getTime() + 7_200_000));
    const r = await raidTick(db);
    expect(r).toMatchObject({ raids: 2, absorbed: 1 });
    const rows = await db.select({ raider: raids.raiderFactionId, count: raids.lowerCount, points: raids.points }).from(raids).orderBy(raids.id);
    // The solo raid follows WOLF's hit 2 h earlier, so BEAR is cheaper — but a
    // solo raid scores 0 whatever the price.
    expect(rows).toEqual([{ raider: WOLF, count: 2, points: BASE_OFFLINE }, { raider: null, count: 1, points: 0 }]);
    const [bear] = await db.select({ t: seasonStandings.timesRaided }).from(seasonStandings).where(eq(seasonStandings.factionId, BEAR));
    expect(bear!.t).toBe(2);
  });

  it("points equal the value rule at the lower: heat raises it, hits lower it, the raid's own row is not in its own price", async () => {
    const C1 = "C1-DAYZID-0000000000000000000000000";
    const cubs = await seedFaction(db, { serverId, tag: "CUBS", texture: "Flag_Cubs", poleKey: "3000.00:100.00:3000.00", createdAt: established, activatedAt: established });
    await db.insert(factionMembers).values({ factionId: cubs.id, serverId, dayzId: C1, discordId: "dC1", role: "leader", joinedAt: now, status: "full" });
    const t1 = now, t2 = new Date(now.getTime() + 3 * 3_600_000), t3 = new Date(now.getTime() + 2 * 86_400_000);
    await lower(W1, "Wolfie", "Flag_Bear", P1, t1); // WOLF raids BEAR
    await lower(C1, "Cub", "Flag_Bear", P1, t2); // CUBS raids BEAR, now cheaper for WOLF's hit
    await lower(C1, "Cub", "Flag_Wolf", P2, t3); // CUBS raids WOLF, dearer for WOLF's heat
    await raidTick(db);
    const rows = await db.select().from(raids).orderBy(raids.id);
    expect(rows).toHaveLength(3);
    const facts: RaidFact[] = rows.map((r) => ({ id: r.id, at: r.firstLowerAt, raiderFactionId: r.raiderFactionId, victimFactionId: r.victimFactionId }));
    const bear = { id: BEAR, activatedAt: established };
    const wolf = { id: WOLF, activatedAt: established };
    // ⚠️ Each price is computed from the rows that existed BEFORE that raid:
    // had its own row counted, raid 1 would pay half.
    expect(rows.map((r) => r.points)).toEqual([
      raidPoints(clanValue(bear, [], t1), false),
      raidPoints(clanValue(bear, facts.slice(0, 1), t2), false),
      raidPoints(clanValue(wolf, facts.slice(0, 2), t3), false),
    ]);
    expect(rows[0]!.points).toBe(BASE_OFFLINE);
    expect(rows[1]!.points).toBeLessThan(BASE_OFFLINE);
    expect(rows[2]!.points).toBeGreaterThan(BASE_OFFLINE);
  });

  it("⚠️ a raid on the #1-ranked clan records victimRankAtLower = 1 (giant_killer reads it), and the rank does not change points", async () => {
    const [season] = await db.select({ id: seasons.id }).from(seasons);
    await db.insert(seasonStandings).values([
      { seasonId: season!.id, factionId: BEAR, points: 500, raids: 5 },
      { seasonId: season!.id, factionId: WOLF, points: 100, raids: 1 },
    ]);
    await lower(W1, "Wolfie", "Flag_Bear", P1, now);
    await raidTick(db);
    const [raid] = await db.select().from(raids);
    expect(raid).toMatchObject({ victimFactionId: BEAR, victimRankAtLower: 1, rankedCountAtLower: 2, points: BASE_OFFLINE });
  });

  const session = async (dayzId: string, from: Date) => {
    const [ev] = await db.insert(events).values({
      serverId, admFileId, lineIndex: lineIndex++, type: "player.connected", occurredAt: from, payload: { dayzId, gamertag: dayzId },
    }).returning();
    await db.insert(playerSessions).values({ serverId, dayzId, connectedAt: from, connectEventId: ev!.id });
  };

  it("a victim with a full member online at the lower pays ×1.5 and is recorded online", async () => {
    await session(B1, new Date(now.getTime() - 3_600_000));
    await lower(W1, "Wolfie", "Flag_Bear", P1, now);
    await raidTick(db);
    const [raid] = await db.select().from(raids);
    expect(raid).toMatchObject({ victimOnline: true, points: raidPoints(clanValue({ id: BEAR, activatedAt: established }, [], now), true) });
    expect(raid!.points).toBe(Math.round(BASE_OFFLINE * 2)); // 1.5 / 0.75
  });

  it("a solo raider scores 0 but the raid still records victimOnline", async () => {
    await session(B1, new Date(now.getTime() - 3_600_000));
    await lower(S1, "Solo", "Flag_Bear", P1, now);
    await raidTick(db);
    const [raid] = await db.select().from(raids);
    expect(raid).toMatchObject({ raiderFactionId: null, points: 0, victimOnline: true, away: false });
  });

  const PU = "7000.00:100.00:7000.00"; // nobody's declared base
  const raise = (dayzId: string, texture: string, poleKey: string, at: Date) =>
    db.insert(events).values({
      serverId, admFileId, lineIndex: lineIndex++, type: "flag.raised", occurredAt: at,
      payload: { dayzId, gamertag: dayzId, texture, poleKey, pole: { x: 1, y: 2, z: 3 } },
    });

  it("an away raid scores and logs like any raid, but leaves flag_down_since alone and queues flag_lowered_away, not flag_down", async () => {
    await raise(B1, "Flag_Bear", PU, new Date(now.getTime() - 3_600_000));
    await lower(W1, "Wolfie", "Flag_Bear", PU, now);
    const r = await raidTick(db);
    expect(r).toMatchObject({ raids: 1 });
    const [raid] = await db.select().from(raids);
    expect(raid).toMatchObject({ victimFactionId: BEAR, raiderFactionId: WOLF, away: true, points: BASE_OFFLINE });
    const [bear] = await db.select({ f: factions.flagDownSince, by: factions.flagDownByDayzId }).from(factions).where(eq(factions.id, BEAR));
    expect(bear).toEqual({ f: null, by: null });
    const [log] = await db.select().from(warLogEvents);
    // ⚠️ Same war-log line as a base raid: saying "away" would hint where the base is NOT.
    expect(log).toMatchObject({ kind: "raid", payload: { raiderClan: "WOLF", victimClan: "BEAR", gamertag: "Wolfie", solo: false, points: BASE_OFFLINE } });
    expect(Object.keys(log!.payload as object).sort()).toEqual(["gamertag", "points", "raiderClan", "raiderTag", "solo", "victimClan", "victimTag"]);
    const notices = await db.select({ target: clanNotices.target, kind: clanNotices.kind, payload: clanNotices.payload }).from(clanNotices);
    expect(notices).toEqual([{ target: "channel", kind: "flag_lowered_away", payload: { gamertag: "Wolfie", raiderClan: "WOLF" } }]);
  });

  it("a base lower absorbed into an earlier away raid by the same clan still starts the flag-down clock", async () => {
    await raise(B1, "Flag_Bear", PU, new Date(now.getTime() - 3_600_000));
    await lower(W1, "Wolfie", "Flag_Bear", PU, now);
    const later = new Date(now.getTime() + 3_600_000);
    expect(later.getTime() - now.getTime()).toBeLessThan(RAID_DEDUP_MS);
    await lower(W1, "Wolfie", "Flag_Bear", P1, later);
    const r = await raidTick(db);
    expect(r).toMatchObject({ raids: 1, absorbed: 1 });
    const [bear] = await db.select({ f: factions.flagDownSince, by: factions.flagDownByDayzId }).from(factions).where(eq(factions.id, BEAR));
    expect(bear).toEqual({ f: later, by: W1 });
    const kinds = (await db.select({ kind: clanNotices.kind, target: clanNotices.target }).from(clanNotices)).map((n) => `${n.kind}:${n.target}`).sort();
    expect(kinds).toEqual(["flag_down:channel", "flag_down:dm", "flag_lowered_away:channel"]);
    // Scoring follows the ordinary dedup rule: one raid, one price.
    expect(await db.select({ c: raids.lowerCount }).from(raids)).toEqual([{ c: 2 }]);
  });

  it("no raid for: a full member's lower (upkeep), a reserved clan, a dormant clan, a solo declaration, an undeclared pole", async () => {
    const P3 = "3000.00:100.00:3000.00";
    const P4 = "4000.00:100.00:4000.00";
    const P5 = "5001.00:100.00:5001.00";
    const P6 = "9999.00:100.00:9999.00";
    await seedFaction(db, { serverId, tag: "RSVD", texture: "Flag_Rsvd", poleKey: P3, status: "reserved", reservedUntil: new Date(now.getTime() + 86_400_000), createdAt: now });
    await seedFaction(db, { serverId, tag: "DRMT", texture: "Flag_Drmt", poleKey: P4, status: "dormant", dormantSince: now, createdAt: now, activatedAt: now });
    await declareSolo(P5, S1);

    await lower(B1, "Bear1", "Flag_Bear", P1, now); // upkeep, not a raid
    await lower(W1, "Wolfie", "Flag_Rsvd", P3, now); // reserved clan: not raidable
    await lower(W1, "Wolfie", "Flag_Drmt", P4, now); // dormant clan: not raidable
    await lower(W1, "Wolfie", "Flag_White", P5, now); // solo declaration: not raidable
    await lower(W1, "Wolfie", "Flag_White", P6, now); // undeclared pole: not raidable

    const r = await raidTick(db);
    expect(r.raids).toBe(0);
    expect(await db.select().from(raids)).toEqual([]);
    const [bear] = await db.select({ f: factions.flagDownSince }).from(factions).where(eq(factions.id, BEAR));
    expect(bear!.f).toBeNull();
  });

  it("a lower with no open season is skipped and reported, and the cursor still advances", async () => {
    await db.execute(sql`delete from seasons where server_id = ${serverId}`);
    await lower(W1, "Wolfie", "Flag_Bear", P1, now);
    const seen: number[] = [];
    const r = await raidTick(db, { onNoSeason: (id) => seen.push(id) });
    expect(r.skippedNoSeason).toBe(1);
    expect(seen).toEqual([serverId]);
    const r2 = await raidTick(db, { onNoSeason: (id) => seen.push(id) });
    expect(r2.scanned).toBe(0);
  });

  it("is idempotent across a crash between the raid insert and the cursor write", async () => {
    await lower(W1, "Wolfie", "Flag_Bear", P1, now);
    await raidTick(db);
    const rows1 = await db.select().from(raids);
    expect(rows1).toHaveLength(1);
    expect(rows1[0]!.lowerCount).toBe(1);
    await db.execute(sql`update consumer_cursors set last_event_id = 0 where consumer_name = 'raid-consumer'`);
    await raidTick(db);
    const rows2 = await db.select().from(raids);
    expect(rows2).toHaveLength(1);
    // ⚠️ The replayed event must not inflate lower_count: it is the exact
    // same first-lower event, not a genuinely new lower inside the window.
    expect(rows2[0]!.lowerCount).toBe(1);
  });

  it("⚠️ a mid-batch failure does not re-apply the raids that already committed", async () => {
    await lower(W1, "Wolfie", "Flag_Bear", P1, now);
    await lower(S1, "Solo", "Flag_Bear", P1, new Date(now.getTime() + 7_200_000));

    // Fail the SECOND raid's transaction, after the first has committed.
    let started = 0;
    const flaky = new Proxy(db, {
      get(t, prop) {
        if (prop === "transaction") {
          return async (fn: unknown) => {
            if (started++ >= 1) throw new Error("injected mid-batch failure");
            return (t as Database).transaction(fn as never);
          };
        }
        const v = Reflect.get(t as object, prop);
        return typeof v === "function" ? v.bind(t) : v;
      },
    }) as Database;

    await expect(raidTick(flaky)).rejects.toThrow(/injected/u);
    expect(await db.select().from(raids)).toHaveLength(1);
    const notices1 = (await db.select().from(clanNotices)).length;
    const warLog1 = (await db.select().from(warLogEvents)).length;

    // The next tick resumes at the first event's committed cursor: it applies
    // the second lower and nothing else.
    await raidTick(db);
    expect(await db.select().from(raids)).toHaveLength(2);
    // The second lower lands while the flag is already down, so it adds a
    // war-log line but no second flag_down burst — and, crucially, the first
    // raid's own notices were not queued twice.
    expect((await db.select().from(warLogEvents)).length).toBe(warLog1 + 1);
    expect((await db.select().from(clanNotices)).length).toBe(notices1);
  });

  it("a genuinely new raid by a different raider does not disturb an already-open flag-down episode", async () => {
    await lower(W1, "Wolfie", "Flag_Bear", P1, now);
    await lower(S1, "Solo", "Flag_Bear", P1, new Date(now.getTime() + 7_200_000));
    const r = await raidTick(db);
    expect(r).toMatchObject({ raids: 2, absorbed: 0 });
    const rows = await db.select().from(raids).orderBy(raids.id);
    expect(rows).toHaveLength(2);
    const [bear] = await db.select({ f: factions.flagDownSince, by: factions.flagDownByDayzId }).from(factions).where(eq(factions.id, BEAR));
    // The clock still reads W1's first lower — a second, different raider's
    // new raid does not restart or move it.
    expect(bear).toEqual({ f: now, by: W1 });
    const notices = await db.select({ kind: clanNotices.kind, target: clanNotices.target }).from(clanNotices);
    const flagDownNotices = notices.filter((n) => n.kind === "flag_down");
    // Exactly one channel row and one DM (to B1), not two of each — the
    // flag was already down when the second raid landed.
    expect(flagDownNotices).toHaveLength(2);
    expect(flagDownNotices.filter((n) => n.target === "channel")).toHaveLength(1);
    expect(flagDownNotices.filter((n) => n.target === "dm")).toHaveLength(1);
  });
});
