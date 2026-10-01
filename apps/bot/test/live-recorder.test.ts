import { describe, it, expect, beforeEach } from "vitest";
import { createClient, runMigrations, requireTestDatabaseUrl, servers, admFiles, events, kills, players, feedEntries, type Database } from "@factions/db";
import { sql } from "drizzle-orm";
import { readCursor } from "@factions/event-log";
import { PgKillFeedStore, KILL_FEED_CONSUMER } from "../src/kill-feed-tick.js";
import { PgKillstreakFeedStore } from "../src/killstreak-feed-tick.js";
import { PgHitFeedStore } from "../src/hit-feed-tick.js";
import { recordKills, recordKillstreaks, recordHits, insertFeedEntry, LIVE_RECORDER_CONSUMERS } from "../src/live-recorder.js";

const URL = requireTestDatabaseUrl();
const A = "A".repeat(40); const B = "B".repeat(40); const R = "R".repeat(40);
const t0 = new Date("2026-09-08T00:00:00Z");
const h = (n: number) => new Date(t0.getTime() + n * 3600_000);

describe("live recorders", () => {
  let db: Database;
  let serverId: number;
  const ids: number[] = [];

  async function mkKill(a: { at: Date; victim: string; killer: string | null }) {
    const [file] = await db.select({ id: admFiles.id }).from(admFiles).where(sql`filename = 'f.ADM'`);
    const [ev] = await db.insert(events).values({ serverId, admFileId: file!.id, lineIndex: ids.length, type: "player.killed" as never, occurredAt: a.at, payload: {} }).returning({ id: events.id });
    await db.insert(kills).values({
      serverId, eventId: ev!.id, occurredAt: a.at, victimDayzId: a.victim, killerDayzId: a.killer,
      weapon: null, distanceM: null, cause: a.killer ? "pvp" : "died", victimFactionId: null, killerFactionId: null, friendlyFire: false, atHub: false,
    });
    ids.push(ev!.id);
    return ev!.id;
  }

  /** A player.hit event shaped like the parser's, positions included. */
  async function mkHit(a: { at: Date; attacker: string; victim: string; damage: number }) {
    const [file] = await db.select({ id: admFiles.id }).from(admFiles).where(sql`filename = 'f.ADM'`);
    await db.insert(events).values({
      serverId, admFileId: file!.id, lineIndex: 5000 + ids.length, type: "player.hit" as never, occurredAt: a.at,
      payload: {
        victimDayzId: a.victim, victimGamertag: "v", victimHp: 40,
        attackerType: "player", attackerDayzId: a.attacker, attackerGamertag: "k", attackerLabel: null,
        damage: a.damage, bodyPart: "Torso", weapon: "KA-74", distanceM: 41,
        victimPos: [7000.5, 200.25, 8000.75], attackerPos: [7040.5, 200.25, 8000.75],
      },
    });
    ids.push(0);
  }

  beforeEach(async () => {
    db = createClient(URL);
    await runMigrations(db);
    await db.execute(sql`truncate table feed_entries, kills, seasons, players, membership_history, declarations, poles, factions, events, raw_lines, adm_files, consumer_cursors, servers restart identity cascade`);
    ids.length = 0;
    const [s] = await db.insert(servers).values({ name: "S", map: "livonia", clockOffsetMs: 0 }).returning();
    serverId = s!.id;
    await db.insert(admFiles).values({ serverId, filename: "f.ADM", bootAt: t0, linesIngested: 0, complete: true });
    await db.insert(players).values([
      { dayzId: A, gamertag: "Alpha", firstSeenAt: t0, lastSeenAt: t0 }, { dayzId: B, gamertag: "Bravo", firstSeenAt: t0, lastSeenAt: t0 },
      { dayzId: R, gamertag: "Romeo", firstSeenAt: t0, lastSeenAt: t0 },
    ]);
  });

  it("first run replays every PvP kill already in the table: the backfill", async () => {
    await mkKill({ at: h(1), killer: A, victim: B });
    await mkKill({ at: h(2), killer: A, victim: R });
    await mkKill({ at: h(3), killer: null, victim: B }); // PvE: never a feed entry
    const store = new PgKillFeedStore(db, { consumer: LIVE_RECORDER_CONSUMERS.kill });
    const r = await recordKills(db, store);
    expect(r.seeded).toBe(false);
    const rows = await db.select().from(feedEntries).orderBy(feedEntries.id);
    expect(rows.map((x) => x.kind)).toEqual(["kill", "kill"]);
    expect((rows[1]!.payload as { tally: { killerKills: number } }).tally.killerKills).toBe(2);
    expect(rows[0]!.serverId).toBe(serverId);
  });

  it("does not touch the Discord poster's cursor, and runs with no poster at all", async () => {
    await mkKill({ at: h(1), killer: A, victim: B });
    await recordKills(db, new PgKillFeedStore(db, { consumer: LIVE_RECORDER_CONSUMERS.kill }));
    expect(await readCursor(db, KILL_FEED_CONSUMER)).toBe(0);
    expect(await db.select().from(feedEntries)).toHaveLength(1);
  });

  it("a crash between insert and cursor write does not duplicate on the re-run", async () => {
    const id = await mkKill({ at: h(1), killer: A, victim: B });
    const store = new PgKillFeedStore(db, { consumer: LIVE_RECORDER_CONSUMERS.kill });
    const [item] = await store.readAfter(0, 1);
    // Simulate: the row landed, the cursor did not.
    await insertFeedEntry(db)({ eventId: id, occurredAt: item!.occurredAt.toISOString(), kind: "kill", payload: {} as never });
    await recordKills(db, store);
    expect(await db.select().from(feedEntries)).toHaveLength(1);
  });

  it("records only streak milestones", async () => {
    for (let n = 1; n <= 4; n++) await mkKill({ at: h(n), killer: A, victim: n % 2 ? B : R });
    await recordKillstreaks(db, new PgKillstreakFeedStore(db, { consumer: LIVE_RECORDER_CONSUMERS.killstreak }), 3);
    const rows = await db.select().from(feedEntries);
    expect(rows.map((r) => (r.payload as { streak: number }).streak)).toEqual([3]);
  });

  it("the hit recorder seeds at the head on its first run: hit history starts at deploy", async () => {
    const r = await recordHits(db, new PgHitFeedStore(db, { consumer: LIVE_RECORDER_CONSUMERS.hit }));
    expect(r.seeded).toBe(true);
    expect(await db.select().from(feedEntries)).toHaveLength(0);
  });

  it("stores no position, even though hit events carry them", async () => {
    const at = h(1);
    await mkHit({ at: new Date(at.getTime() - 30_000), attacker: A, victim: B, damage: 38 });
    await mkHit({ at: new Date(at.getTime() - 10_000), attacker: A, victim: B, damage: 22 });
    await mkKill({ at, killer: A, victim: B });
    await recordKills(db, new PgKillFeedStore(db, { consumer: LIVE_RECORDER_CONSUMERS.kill }));
    const [row] = await db.select().from(feedEntries);
    const payload = row!.payload as { hits: Array<Record<string, unknown>> };
    // The hit lines are there, so the absence of a position is not an empty-run accident.
    expect(payload.hits).toHaveLength(2);
    for (const line of payload.hits) {
      expect(Object.keys(line).sort()).toEqual(["bodyPart", "damage", "distanceM", "weapon"]);
    }
    const json = JSON.stringify(row!.payload);
    expect(json).not.toMatch(/Pos"|"x"|"y"|"z"/u);
    expect(json).not.toContain("7000.5");
  });
});
