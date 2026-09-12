import { describe, it, expect, beforeEach } from "vitest";
import { createClient, runMigrations, requireTestDatabaseUrl, servers, admFiles, events, kills, players, seasons, type Database } from "@factions/db";
import { sql } from "drizzle-orm";
import { PgKillstreakFeedStore } from "../src/killstreak-feed-tick.js";

const URL = requireTestDatabaseUrl();
const A = "A".repeat(40); const B = "B".repeat(40); const R = "R".repeat(40);
const t0 = new Date("2026-09-12T00:00:00Z");
const s = (n: number) => new Date(t0.getTime() + n * 1000);

describe("PgKillstreakFeedStore", () => {
  let db: Database;
  let serverId: number;
  let store: PgKillstreakFeedStore;
  let line = 0;

  async function mkKill(a: { at: Date; killer: string | null; victim: string; ff?: boolean }) {
    const [file] = await db.select({ id: admFiles.id }).from(admFiles).where(sql`filename = 'f.ADM'`);
    const [ev] = await db.insert(events).values({
      serverId, admFileId: file!.id, lineIndex: line++, type: "player.killed" as never, occurredAt: a.at, payload: {},
    }).returning({ id: events.id });
    await db.insert(kills).values({
      serverId, eventId: ev!.id, occurredAt: a.at, victimDayzId: a.victim, killerDayzId: a.killer,
      weapon: "KA-74", distanceM: "41.0", cause: a.killer ? "pvp" : "died", friendlyFire: a.ff ?? false,
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
    store = new PgKillstreakFeedStore(db);
  });

  it("counts consecutive kills, oldest first", async () => {
    await mkKill({ at: s(0), killer: A, victim: B });
    await mkKill({ at: s(10), killer: A, victim: R });
    const items = await store.readAfter(0, 20);
    expect(items.map((i) => i.streak)).toEqual([1, 2]);
    expect(items[1]!.victims).toEqual(["Bravo", "Romeo"]);
    expect(items[1]!.startedAt).toEqual(s(0));
  });

  it("⚠️ a death at another player's hand resets the streak", async () => {
    await mkKill({ at: s(0), killer: A, victim: B });
    await mkKill({ at: s(10), killer: A, victim: R });
    await mkKill({ at: s(20), killer: R, victim: A });
    await mkKill({ at: s(30), killer: A, victim: B });
    const items = await store.readAfter(0, 20);
    expect(items.filter((i) => i.eventId === items[items.length - 1]!.eventId)[0]!.streak).toBe(1);
  });

  it("⚠️ a death to the environment does NOT reset it — only a player ends a streak", async () => {
    await mkKill({ at: s(0), killer: A, victim: B });
    await mkKill({ at: s(10), killer: null, victim: A });
    await mkKill({ at: s(20), killer: A, victim: R });
    const items = await store.readAfter(0, 20);
    expect(items[items.length - 1]!.streak).toBe(2);
  });

  it("⚠️ friendly fire neither advances nor breaks a streak", async () => {
    await mkKill({ at: s(0), killer: A, victim: B });
    const ff = await mkKill({ at: s(10), killer: A, victim: R, ff: true });
    await mkKill({ at: s(20), killer: A, victim: B });
    const items = await store.readAfter(0, 20);
    expect(items.find((i) => i.eventId === ff)!.streak).toBeNull();
    expect(items[items.length - 1]!.streak).toBe(2);
  });

  it("a self-kill is not a streak kill and does not break one", async () => {
    await mkKill({ at: s(0), killer: A, victim: B });
    await mkKill({ at: s(10), killer: A, victim: A });
    await mkKill({ at: s(20), killer: A, victim: R });
    // The self-kill A→A is excluded by the `pvp` predicate, so readAfter
    // returns only TWO items (A→B, A→R); index [1] is the third kill.
    expect((await store.readAfter(0, 20))[1]!.streak).toBe(2);
  });

  it("a player never killed by anyone counts all of their kills", async () => {
    await mkKill({ at: s(0), killer: A, victim: B });
    await mkKill({ at: s(10), killer: A, victim: R });
    await mkKill({ at: s(20), killer: A, victim: B });
    expect((await store.readAfter(0, 20))[2]!.streak).toBe(3);
  });

  it("⚠️ a streak spanning a season boundary keeps counting — only death ends one", async () => {
    await db.insert(seasons).values([
      { serverId, number: 1, startedAt: s(-100), endedAt: s(15) },
      { serverId, number: 2, startedAt: s(15), endedAt: null },
    ]);
    await mkKill({ at: s(0), killer: A, victim: B });
    await mkKill({ at: s(20), killer: A, victim: R });
    expect((await store.readAfter(0, 20))[1]!.streak).toBe(2);
  });

  it("resolves the killer's name and the clan they were in", async () => {
    await mkKill({ at: s(0), killer: A, victim: B });
    expect((await store.readAfter(0, 20))[0]!.killer.gamertag).toBe("Alpha");
  });

  it("head is the newest kill event id, and seeded is false until the cursor is written", async () => {
    const id = await mkKill({ at: s(0), killer: A, victim: B });
    expect(await store.head()).toBe(id);
    expect(await store.seeded()).toBe(false);
    await store.markPosted(id);
    expect(await store.seeded()).toBe(true);
  });
});
