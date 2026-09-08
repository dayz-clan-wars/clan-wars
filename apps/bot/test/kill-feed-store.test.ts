import { describe, it, expect, beforeEach } from "vitest";
import { createClient, runMigrations, requireTestDatabaseUrl, servers, admFiles, events, kills, players, seasons, type Database } from "@factions/db";
import { sql } from "drizzle-orm";
import { seedFaction } from "./seed.js";
import { PgKillFeedStore, KILL_FEED_CONSUMER } from "../src/kill-feed-tick.js";
import { readCursor } from "@factions/event-log";

const URL = requireTestDatabaseUrl();
const A = "A".repeat(40); const B = "B".repeat(40); const R = "R".repeat(40); const N = "N".repeat(40);
const t0 = new Date("2026-09-08T00:00:00Z");
const h = (n: number) => new Date(t0.getTime() + n * 3600_000);

describe("PgKillFeedStore", () => {
  let db: Database;
  let serverId: number;
  let store: PgKillFeedStore;
  const ids: number[] = [];

  /** A kill whose backing event exists; returns the event id. */
  async function mkKill(a: { at: Date; victim: string; killer: string | null; weapon?: string | null; distanceM?: number | null; vf?: number | null; kf?: number | null; ff?: boolean }) {
    const [file] = await db.select({ id: admFiles.id }).from(admFiles).where(sql`filename = 'f.ADM'`);
    const [ev] = await db.insert(events).values({ serverId, admFileId: file!.id, lineIndex: ids.length, type: "player.killed" as never, occurredAt: a.at, payload: {} }).returning({ id: events.id });
    await db.insert(kills).values({
      serverId, eventId: ev!.id, occurredAt: a.at, victimDayzId: a.victim, killerDayzId: a.killer,
      weapon: a.weapon ?? null, distanceM: a.distanceM === undefined || a.distanceM === null ? null : String(a.distanceM),
      cause: a.killer ? "pvp" : "died", victimFactionId: a.vf ?? null, killerFactionId: a.kf ?? null, friendlyFire: a.ff ?? false,
    });
    ids.push(ev!.id);
    return ev!.id;
  }

  beforeEach(async () => {
    db = createClient(URL);
    await runMigrations(db);
    await db.execute(sql`truncate table kills, seasons, players, membership_history, declarations, poles, factions, events, raw_lines, adm_files, consumer_cursors, servers restart identity cascade`);
    ids.length = 0;
    const [s] = await db.insert(servers).values({ name: "S", map: "livonia", clockOffsetMs: 0 }).returning();
    serverId = s!.id;
    await db.insert(admFiles).values({ serverId, filename: "f.ADM", bootAt: t0, linesIngested: 0, complete: true });
    await db.insert(players).values([
      { dayzId: A, gamertag: "Alpha", firstSeenAt: t0, lastSeenAt: t0 }, { dayzId: B, gamertag: "Bravo", firstSeenAt: t0, lastSeenAt: t0 },
      { dayzId: R, gamertag: "Romeo", firstSeenAt: t0, lastSeenAt: t0 },
    ]);
    store = new PgKillFeedStore(db);
  });

  it("is unseeded until the cursor row exists; head is the newest kill's event id", async () => {
    expect(await store.seeded()).toBe(false);
    expect(await store.head()).toBe(0);
    const e1 = await mkKill({ at: h(1), victim: R, killer: A });
    expect(await store.head()).toBe(e1);
    await store.markPosted(e1);
    expect(await store.seeded()).toBe(true);
    expect(await store.cursor()).toBe(e1);
    expect(await readCursor(db, KILL_FEED_CONSUMER)).toBe(e1);
  });

  it("reads PvP kills after the cursor with names, the clans of the moment, weapon, distance and tally", async () => {
    const bear = await seedFaction(db, { serverId, tag: "BEAR", texture: "Flag_Bear", createdAt: t0 });
    const wolf = await seedFaction(db, { serverId, tag: "WOLF", texture: "Flag_Wolf", createdAt: t0, poleKey: "8000.00:100.00:8000.00", x: 8000, z: 8000 });
    await db.insert(seasons).values({ serverId, number: 1, startedAt: h(-24), endedAt: null });
    const e1 = await mkKill({ at: h(1), victim: R, killer: A, weapon: "KA-74", distanceM: 40.7, vf: wolf.id, kf: bear.id });
    await mkKill({ at: h(2), victim: A, killer: null });                  // no killer: not on the feed
    await mkKill({ at: h(3), victim: A, killer: A, kf: bear.id, vf: bear.id }); // self-kill: not on the feed
    const e4 = await mkKill({ at: h(4), victim: B, killer: A, vf: bear.id, kf: bear.id, ff: true });
    const e5 = await mkKill({ at: h(5), victim: R, killer: A, weapon: "M4-A1", vf: wolf.id, kf: bear.id });

    const all = await store.readAfter(0, 10);
    expect(all.map((k) => k.eventId)).toEqual([e1, e4, e5]);
    expect(all[0]).toMatchObject({
      killer: { gamertag: "Alpha", tag: "BEAR", texture: "Flag_Bear" },
      victim: { gamertag: "Romeo", tag: "WOLF", texture: "Flag_Wolf" },
      weapon: "KA-74", distanceM: 40.7, friendlyFire: false,
      tally: { killerKills: 1, victimDeaths: 1, season: 1 },
    });
    // The tally is as of EACH kill: by e5 Alpha has 3 PvP kills (incl. the friendly one) and Romeo 2 deaths.
    expect(all[2]!.tally).toEqual({ killerKills: 3, victimDeaths: 2, season: 1 });
    expect(all[1]!.friendlyFire).toBe(true);

    expect((await store.readAfter(e4, 10)).map((k) => k.eventId)).toEqual([e5]);
    expect(await store.readAfter(0, 1)).toHaveLength(1);
  });

  it("a player in no clan, or unknown to the projection, still renders", async () => {
    await mkKill({ at: h(1), victim: N, killer: R });
    const [k] = await store.readAfter(0, 10);
    expect(k!.killer).toEqual({ gamertag: "Romeo", tag: null, texture: null });
    expect(k!.victim).toEqual({ gamertag: "Unknown", tag: null, texture: null });
    expect(k!.tally).toEqual({ killerKills: 1, victimDeaths: 1, season: null });
  });

  it("the tally counts in the season the kill belongs to, and all-time before any season", async () => {
    await db.insert(seasons).values([
      { serverId, number: 1, startedAt: h(-48), endedAt: h(-24) },
      { serverId, number: 2, startedAt: h(-24), endedAt: null },
    ]);
    const e0 = await mkKill({ at: h(-60), victim: R, killer: A }); // before season 1: all-time
    const e1 = await mkKill({ at: h(-30), victim: R, killer: A }); // season 1
    const e2 = await mkKill({ at: h(1), victim: R, killer: A });   // season 2
    const [k0, k1, k2] = await store.readAfter(0, 10);
    expect(k0!.eventId).toBe(e0);
    expect(k0!.tally).toEqual({ killerKills: 1, victimDeaths: 1, season: null });
    expect(k1!.eventId).toBe(e1);
    expect(k1!.tally).toEqual({ killerKills: 1, victimDeaths: 1, season: 1 });
    expect(k2!.eventId).toBe(e2);
    // ⚠️ Season 2 only: the season-1 kill and the pre-season kill are not in this window.
    expect(k2!.tally).toEqual({ killerKills: 1, victimDeaths: 1, season: 2 });
  });
});
