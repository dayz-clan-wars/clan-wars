import { describe, it, expect, beforeEach } from "vitest";
import {
  createClient, runMigrations, requireTestDatabaseUrl,
  servers, seasons, seasonStandings, declarations, poles, identityHolds, factions, events, admFiles, warLogEvents,
  type Database,
} from "@factions/db";
import { sql, eq, asc } from "drizzle-orm";
import { POST_WIPE_BIND_MS } from "@factions/domain";
import { wipe } from "../src/wipe.js";
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

  beforeEach(async () => {
    db = createClient(URL);
    await runMigrations(db);
    await db.transaction(async (tx) => {
      await tx.execute(sql`set local client_min_messages = warning`);
      await tx.execute(sql`truncate table war_log_events, season_results, season_standings, identity_holds, declarations, poles, faction_members, events, adm_files, seasons, factions, servers restart identity cascade`);
    });
    const [s] = await db.insert(servers).values({ name: "S", map: "livonia", clockOffsetMs: 0 }).returning();
    serverId = s!.id;
    const [a] = await db.insert(admFiles).values({
      serverId, filename: "f.ADM", bootAt: ago(30 * 86_400_000), linesIngested: 0, complete: true,
    }).returning();
    admFileId = a!.id;

    await seedSeason(db, serverId, ago(30 * 86_400_000));

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

  it("does §8.5 in one transaction", async () => {
    const r = await wipe(db, serverId, wipeAt);
    expect(r).toMatchObject({
      skipped: false, closedSeason: 1, openedSeason: 2,
      holdsEnded: 1, declarationsDeleted: 3, polesStamped: 3, clansCleared: 2,
    });

    expect(await db.select().from(declarations)).toEqual([]);

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
    const again = await wipe(db, serverId, wipeAt);
    expect(again.skipped).toBe(true);
    expect(await db.select().from(seasons)).toHaveLength(2);
    expect(await db.select().from(warLogEvents)).toHaveLength(1);
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
