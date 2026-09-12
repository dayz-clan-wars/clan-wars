import { describe, it, expect, beforeEach } from "vitest";
import { createClient, runMigrations, requireTestDatabaseUrl, servers, admFiles, events, kills, players, type Database } from "@factions/db";
import { sql } from "drizzle-orm";
import { writeCursor } from "@factions/event-log";
import { PgHitFeedStore } from "../src/hit-feed-tick.js";
import { KILLS_CONSUMER } from "../src/kills-tick.js";

const URL = requireTestDatabaseUrl();
const A = "A".repeat(40); const B = "B".repeat(40); const R = "R".repeat(40);
const t0 = new Date("2026-09-12T00:00:00Z");
const s = (n: number) => new Date(t0.getTime() + n * 1000);

describe("PgHitFeedStore", () => {
  let db: Database;
  let serverId: number;
  let store: PgHitFeedStore;
  let line = 0;

  async function mkHit(a: { at: Date; attacker: string | null; victim: string; weapon?: string | null; damage?: number; hp?: number }) {
    const [file] = await db.select({ id: admFiles.id }).from(admFiles).where(sql`filename = 'f.ADM'`);
    const [ev] = await db.insert(events).values({
      serverId, admFileId: file!.id, lineIndex: line++, type: "player.hit" as never, occurredAt: a.at,
      payload: {
        victimDayzId: a.victim, victimGamertag: "v", victimHp: a.hp ?? 60,
        attackerType: a.attacker ? "player" : "infected",
        attackerDayzId: a.attacker, attackerGamertag: a.attacker ? "k" : null,
        attackerLabel: a.attacker ? null : "Infected",
        damage: a.damage ?? 38, bodyPart: "Torso",
        weapon: a.weapon === undefined ? "KA-74" : a.weapon, distanceM: 41,
      },
    }).returning({ id: events.id });
    return ev!.id;
  }

  /** A marker event that moves the ingest frontier forward without being a hit. */
  async function mkFrontier(at: Date) {
    const [file] = await db.select({ id: admFiles.id }).from(admFiles).where(sql`filename = 'f.ADM'`);
    const [ev] = await db.insert(events).values({
      serverId, admFileId: file!.id, lineIndex: line++, type: "player.connected" as never, occurredAt: at, payload: {},
    }).returning({ id: events.id });
    // The kills projector has seen everything up to here.
    await writeCursor(db, KILLS_CONSUMER, ev!.id);
    return ev!.id;
  }

  async function mkKill(a: { at: Date; killer: string; victim: string }) {
    const [file] = await db.select({ id: admFiles.id }).from(admFiles).where(sql`filename = 'f.ADM'`);
    const [ev] = await db.insert(events).values({
      serverId, admFileId: file!.id, lineIndex: line++, type: "player.killed" as never, occurredAt: a.at, payload: {},
    }).returning({ id: events.id });
    await db.insert(kills).values({
      serverId, eventId: ev!.id, occurredAt: a.at, victimDayzId: a.victim, killerDayzId: a.killer,
      weapon: "KA-74", distanceM: "41.0", cause: "pvp", friendlyFire: false,
    });
    return ev!.id;
  }

  beforeEach(async () => {
    db = createClient(URL);
    await runMigrations(db);
    await db.execute(sql`truncate table kills, seasons, players, membership_history, declarations, poles, factions, events, raw_lines, adm_files, consumer_cursors, servers restart identity cascade`);
    line = 0;
    const [srv] = await db.insert(servers).values({ name: "S", map: "livonia", clockOffsetMs: 0 }).returning();
    serverId = srv!.id;
    await db.insert(admFiles).values({ serverId, filename: "f.ADM", bootAt: t0, linesIngested: 0, complete: true });
    await db.insert(players).values([
      { dayzId: A, gamertag: "Alpha", firstSeenAt: t0, lastSeenAt: t0 },
      { dayzId: B, gamertag: "Bravo", firstSeenAt: t0, lastSeenAt: t0 },
      { dayzId: R, gamertag: "Romeo", firstSeenAt: t0, lastSeenAt: t0 },
    ]);
    store = new PgHitFeedStore(db);
  });

  it("returns one item per closed engagement, with names resolved and damage totalled", async () => {
    await mkHit({ at: s(0), attacker: A, victim: B, damage: 38 });
    await mkHit({ at: s(4), attacker: A, victim: B, damage: 38, hp: 12 });
    await mkFrontier(s(400));
    const items = await store.readAfter(0, 20);
    expect(items).toHaveLength(1);
    expect(items[0]!.attacker.gamertag).toBe("Alpha");
    expect(items[0]!.victim.gamertag).toBe("Bravo");
    expect(items[0]!.hits).toHaveLength(2);
    expect(items[0]!.totalDamage).toBe(76);
    expect(items[0]!.victimHpAfter).toBe(12);
    expect(items[0]!.suppressed).toBe(false);
  });

  it("⚠️ an engagement still open is not returned at all — the cursor must not step over it", async () => {
    await mkHit({ at: s(0), attacker: A, victim: B });
    await mkFrontier(s(30));
    expect(await store.readAfter(0, 20)).toEqual([]);
  });

  it("⚠️ an engagement a kill claimed comes back SUPPRESSED, not absent — it still advances the cursor", async () => {
    await mkHit({ at: s(0), attacker: A, victim: B });
    await mkHit({ at: s(4), attacker: A, victim: B });
    await mkKill({ at: s(6), killer: A, victim: B });
    await mkFrontier(s(400));
    const items = await store.readAfter(0, 20);
    expect(items).toHaveLength(1);
    expect(items[0]!.suppressed).toBe(true);
  });

  it("⚠️ suppression ignores the weapon, so a weapon switch before the kill does not orphan the first half", async () => {
    await mkHit({ at: s(0), attacker: A, victim: B, weapon: "KA-74" });
    await mkHit({ at: s(4), attacker: A, victim: B, weapon: "Mosin" });
    await mkKill({ at: s(6), killer: A, victim: B });
    await mkFrontier(s(400));
    const items = await store.readAfter(0, 20);
    expect(items).toHaveLength(2);
    expect(items.map((i) => i.suppressed)).toEqual([true, true]);
  });

  it("a kill by someone else does not suppress this attacker's engagement", async () => {
    await mkHit({ at: s(0), attacker: A, victim: B });
    await mkKill({ at: s(6), killer: R, victim: B });
    await mkFrontier(s(400));
    const items = await store.readAfter(0, 20);
    expect(items[0]!.suppressed).toBe(false);
  });

  it("a kill more than the attribution window after the last hit does not suppress it", async () => {
    await mkHit({ at: s(0), attacker: A, victim: B });
    await mkKill({ at: s(200), killer: A, victim: B });
    await mkFrontier(s(900));
    const items = await store.readAfter(0, 20);
    expect(items[0]!.suppressed).toBe(false);
  });

  it("⚠️ a wedged kills projector holds everything back rather than leaking fatal fights into the feed", async () => {
    await mkHit({ at: s(0), attacker: A, victim: B });
    // Ingest has run far ahead, but the kills cursor is still at 0.
    const [file] = await db.select({ id: admFiles.id }).from(admFiles).where(sql`filename = 'f.ADM'`);
    await db.insert(events).values({ serverId, admFileId: file!.id, lineIndex: line++, type: "player.connected" as never, occurredAt: s(900), payload: {} });
    expect(await store.readAfter(0, 20)).toEqual([]);
  });

  it("PvE and self-inflicted hits never reach the feed", async () => {
    await mkHit({ at: s(0), attacker: null, victim: B });
    await mkHit({ at: s(1), attacker: B, victim: B });
    await mkFrontier(s(400));
    expect(await store.readAfter(0, 20)).toEqual([]);
  });

  it("head is the newest hit event id, and seeded is false until the cursor is written", async () => {
    const id = await mkHit({ at: s(0), attacker: A, victim: B });
    expect(await store.head()).toBe(id);
    expect(await store.seeded()).toBe(false);
    await store.markPosted(id);
    expect(await store.seeded()).toBe(true);
    expect(await store.cursor()).toBe(id);
  });

  it("reads only after the cursor", async () => {
    await mkHit({ at: s(0), attacker: A, victim: B });
    const second = await mkHit({ at: s(300), attacker: A, victim: B });
    await mkFrontier(s(900));
    const items = await store.readAfter(second - 1, 20);
    expect(items).toHaveLength(1);
    expect(items[0]!.eventId).toBe(second);
  });
});
