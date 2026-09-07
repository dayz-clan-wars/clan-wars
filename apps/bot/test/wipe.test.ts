import { describe, it, expect, beforeEach } from "vitest";
import {
  createClient, runMigrations, requireTestDatabaseUrl,
  servers, seasons, seasonStandings, declarations, poles, identityHolds, factions, events, admFiles, warLogEvents,
  alphaWeeks, raids, clanPins, intruderSightings,
  type Database,
} from "@factions/db";
import { sql, eq, asc } from "drizzle-orm";
import { POST_WIPE_BIND_MS, weekStartOf } from "@factions/domain";
import { wipe, wipeTx } from "../src/wipe.js";
import { openSeason } from "../src/season.js";
import { seedFaction, seedSeason } from "./seed.js";

const URL = requireTestDatabaseUrl();
const now = new Date("2026-09-02T12:00:00Z");
const ago = (ms: number) => new Date(now.getTime() - ms);
const wipeAt = new Date("2026-09-30T00:00:00Z");
const finite = new Date("2026-10-15T00:00:00Z");

describe("wipe", () => {
  let db: Database;
  let serverId = 0;
  let admFileId = 0;
  let lineIndex = 0;
  let WOLF = 0;
  let BEAR = 0;
  let seasonId = 0;

  /**
   * A raid row, written directly (this file's concern is the wipe that reads
   * `raids` through `weekTopThree`, not the consumer that writes them —
   * `week-tick.test.ts` uses the same shortcut).
   */
  const seedRaid = async (a: { raider: number; victim: number; points: number; at: Date }) => {
    const [ev] = await db.insert(events).values({
      serverId, admFileId, lineIndex: lineIndex++, type: "flag.lowered", occurredAt: a.at, payload: {},
    }).returning();
    await db.insert(raids).values({
      seasonId, serverId, victimFactionId: a.victim, raiderDayzId: "X", raiderFactionId: a.raider,
      firstLowerEventId: ev!.id, firstLowerAt: a.at, lastLowerAt: a.at, lastLowerEventId: ev!.id,
      lowerCount: 1, points: a.points, victimRankAtLower: null, rankedCountAtLower: 0,
      weekStart: weekStartOf(a.at),
    });
  };

  beforeEach(async () => {
    db = createClient(URL);
    await runMigrations(db);
    await db.transaction(async (tx) => {
      await tx.execute(sql`set local client_min_messages = warning`);
      await tx.execute(sql`truncate table war_log_events, alpha_weeks, raids, season_results, season_standings, identity_holds, declarations, poles, faction_members, events, adm_files, seasons, factions, servers restart identity cascade`);
    });
    const [s] = await db.insert(servers).values({ name: "S", map: "livonia", clockOffsetMs: 0 }).returning();
    serverId = s!.id;
    const [a] = await db.insert(admFiles).values({
      serverId, filename: "f.ADM", bootAt: ago(30 * 86_400_000), linesIngested: 0, complete: true,
    }).returning();
    admFileId = a!.id;

    const season = await seedSeason(db, serverId, ago(30 * 86_400_000));
    seasonId = season.id;

    const wolf = await seedFaction(db, {
      serverId, tag: "WOLF", texture: "Flag_Wolf", poleKey: "1000.00:100.00:1000.00",
      createdAt: ago(30 * 86_400_000), activatedAt: ago(30 * 86_400_000), status: "active",
    });
    WOLF = wolf.id;
    await db.update(factions).set({ flagDownSince: ago(1000), flagDownByDayzId: "X" }).where(eq(factions.id, WOLF));

    const bear = await seedFaction(db, {
      serverId, tag: "BEAR", texture: "Flag_Bear", poleKey: "2000.00:100.00:2000.00",
      createdAt: ago(30 * 86_400_000), activatedAt: ago(30 * 86_400_000), status: "dormant", dormantSince: ago(500_000),
    });
    BEAR = bear.id;
    await db.update(factions).set({ disbandWarnedAt: ago(1000) }).where(eq(factions.id, BEAR));

    // A solo declaration — its own pole, owned by a dayzId rather than a faction.
    const [ev] = await db.insert(events).values({
      serverId, admFileId, lineIndex: lineIndex++, type: "flag.raised", occurredAt: ago(999_999),
      payload: { dayzId: "SOLO", gamertag: "soloist", texture: "Flag_White", poleKey: "3000.00:100.00:3000.00" },
    }).returning();
    await db.insert(poles).values({
      serverId, map: "livonia", poleKey: "3000.00:100.00:3000.00", x: "3000.00", y: "100.00", z: "3000.00",
      currentTexture: "Flag_White", flagRaised: true, firstSeenAt: ago(999_999), lastSeenAt: ago(999_999),
      graceUntil: ago(0),
    });
    await db.insert(declarations).values({
      serverId, poleKey: "3000.00:100.00:3000.00", x: "3000.00", y: "100.00", z: "3000.00",
      ownerDayzId: "SOLO", evidenceEventId: ev!.id, declaredAt: ago(999_999),
    });

    // Identity holds: WOLF's at the 'infinity' sentinel, BEAR's already finite.
    await db.execute(sql`insert into identity_holds (server_id, kind, value_lower, faction_id, reason, held_until)
      values (${serverId}, 'name', 'oldwolf', ${WOLF}, 'renamed', 'infinity')`);
    await db.insert(identityHolds).values({
      serverId, kind: "tag", valueLower: "oldb", factionId: BEAR, reason: "disbanded", heldUntil: finite,
    });
  });

  /** Everything a second wipe would touch, for an unchanged-by-the-re-run comparison. */
  const snapshot = async () => ({
    seasons: (await db.select().from(seasons)).length,
    declarations: (await db.select().from(declarations)).length,
    warLog: (await db.select().from(warLogEvents)).length,
    alphaWeeks: (await db.select().from(alphaWeeks)).length,
    poles: await db.select({ id: poles.id, g: poles.graceUntil }).from(poles).orderBy(asc(poles.id)),
  });

  it("does §8.5 in one transaction", async () => {
    // The map's wipe-scoped state (§8.5 step 5): one pin on WOLF, one
    // sighting on WOLF's declaration.
    const [wolfDecl] = await db.select({ id: declarations.id }).from(declarations).where(eq(declarations.ownerFactionId, WOLF));
    await db.insert(clanPins).values({
      factionId: WOLF, dayzId: "A".repeat(40), x: "1", z: "1", icon: "loot",
      createdAt: ago(1), expiresAt: new Date(now.getTime() + 999_999),
    });
    await db.insert(intruderSightings).values({
      declarationId: wolfDecl!.id, dayzId: "B".repeat(40),
      firstSeenAt: ago(1), lastSeenAt: ago(1), lastAlertAt: ago(1), distanceM: 1, lastX: "1", lastZ: "1",
    });

    const r = await wipe(db, serverId, wipeAt);
    expect(r).toMatchObject({
      skipped: false, closedSeason: 1, openedSeason: 2,
      holdsEnded: 1, declarationsDeleted: 3, polesStamped: 3, clansCleared: 2,
      // Season 1 opened Mon 2026-08-03; the last week to end at or before
      // wipeAt (Wed 2026-09-30) is the one starting 2026-09-21.
      weeksClosed: 8,
      pinsCleared: 1, sightingsCleared: 1,
    });

    expect(await db.select().from(declarations)).toEqual([]);
    expect(await db.select().from(clanPins)).toEqual([]);
    expect(await db.select().from(intruderSightings)).toEqual([]);

    for (const p of await db.select().from(poles)) {
      expect(p.graceUntil).toEqual(new Date(wipeAt.getTime() + POST_WIPE_BIND_MS));
      expect(p.flagRaised).toBe(false);
    }

    for (const f of await db.select().from(factions)) {
      expect(f.flagDownSince).toBeNull();
      expect(f.disbandWarnedAt).toBeNull();
      expect(["active", "dormant"]).toContain(f.status);
    }

    const holds = await db.select().from(identityHolds).orderBy(asc(identityHolds.id));
    expect(holds[0]!.heldUntil).toEqual(wipeAt);
    expect(holds[1]!.heldUntil).toEqual(finite);

    const open = await openSeason(db, serverId);
    expect(open).toMatchObject({ number: 2, startedAt: wipeAt });
    expect(await db.select().from(seasonStandings).where(eq(seasonStandings.seasonId, open!.id))).toEqual([]);
  });

  it("⚠️ wipe twice is once", async () => {
    await wipe(db, serverId, wipeAt);
    const after = await snapshot();
    const again = await wipe(db, serverId, wipeAt);
    expect(again.skipped).toBe(true);
    expect(again.openedSeason).toBe(2);
    expect(await snapshot()).toEqual(after);
    expect(after.seasons).toBe(2);
  });

  it("⚠️ a re-run with a LATER --at is skipped too", async () => {
    // The operator re-runs after a typo, or without --at on an older build:
    // the season on offer is the one the first run opened minutes ago, not a
    // season boundary. The guard is the open season's age, not the timestamp.
    await wipe(db, serverId, wipeAt);
    const after = await snapshot();
    const again = await wipe(db, serverId, new Date(wipeAt.getTime() + 3_600_000));
    expect(again.skipped).toBe(true);
    expect(again.openedSeason).toBe(2);
    expect(await snapshot()).toEqual(after);
  });

  it("⚠️ a second wipe that races the first blocks on the lock, then skips", async () => {
    // Connection A opens a transaction and runs the whole wipe in it without
    // committing; connection B starts a second wipe with a later --at. B's
    // first statement is `factions ... FOR UPDATE`, which A holds, so B waits
    // for A to commit and only then reads the season table — under the locks,
    // where it sees the season A just opened and skips. The pre-lock guard
    // this replaces read the season table before taking any lock, so both
    // invocations passed it and the second one wiped.
    const dbB = createClient(URL);
    try {
      let bSettled = false;
      let bPromise: Promise<unknown> | undefined;
      await db.transaction(async (tx) => {
        await wipeTx(tx, serverId, wipeAt);
        bPromise = wipe(dbB, serverId, new Date(wipeAt.getTime() + 3_600_000));
        void bPromise.then(() => { bSettled = true; }, () => { bSettled = true; });
        // Long enough for B to reach the lock. B must NOT be awaited here —
        // it cannot finish until this transaction commits.
        await new Promise((r) => setTimeout(r, 300));
        expect(bSettled).toBe(false);
      });
      expect(await bPromise!).toMatchObject({ skipped: true, closedSeason: null, openedSeason: 2, weeksClosed: 0 });
      expect(await db.select().from(seasons)).toHaveLength(2);
      expect(await db.select().from(warLogEvents)).toHaveLength(9);
      expect(await db.select().from(declarations)).toEqual([]);
    } finally {
      await dbB.$client.end();
    }
  });

  it("closes the season's last elapsed week before it closes the season", async () => {
    // The runbook stops the bot on the Sunday evening and wipes on the
    // Monday morning: the week that ended at Monday 00:00 UTC elapsed
    // entirely while the bot was down, and once `ended_at` is set the week
    // tick — which only walks OPEN seasons — can never crown its Alphas.
    const mondayWipe = new Date("2026-09-28T06:00:00Z");
    const lastWeek = new Date("2026-09-21T00:00:00Z");
    await seedRaid({ raider: WOLF, victim: BEAR, points: 200, at: new Date("2026-09-23T12:00:00Z") });

    const r = await wipe(db, serverId, mondayWipe);
    expect(r).toMatchObject({ skipped: false, closedSeason: 1, weeksClosed: 8 });

    expect(await db.select().from(alphaWeeks).where(eq(alphaWeeks.weekStart, lastWeek)))
      .toMatchObject([{ rank: 1, factionId: WOLF, points: 200 }]);

    const [closedSeason] = await db.select({ w: seasons.weekClosedThrough }).from(seasons).where(eq(seasons.number, 1));
    expect(closedSeason!.w).toEqual(lastWeek); // the Monday minus 7

    const lines = await db.select({ k: warLogEvents.kind }).from(warLogEvents).orderBy(asc(warLogEvents.id));
    expect(lines.filter((l) => l.k === "week_closed")).toHaveLength(8);
    expect(lines.at(-1)!.k).toBe("season_closed"); // every week_closed precedes it
  });

  it("a failing step rolls the whole wipe back", async () => {
    // Pre-insert an already-closed season number 2 with a different
    // started_at, so step (6)'s insert collides with seasons_number_uniq
    // (server_id, number) — closed, so it doesn't itself trip
    // seasons_open_uniq alongside the still-open season 1.
    await db.insert(seasons).values({ serverId, number: 2, startedAt: ago(2), endedAt: ago(1) });

    await expect(wipe(db, serverId, wipeAt)).rejects.toThrow();

    expect(await db.select().from(declarations)).toHaveLength(3);
    const open = await openSeason(db, serverId);
    expect(open).toMatchObject({ number: 1 });
  });
});
