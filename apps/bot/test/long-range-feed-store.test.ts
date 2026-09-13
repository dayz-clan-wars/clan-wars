import { describe, it, expect, beforeEach } from "vitest";
import { createClient, runMigrations, requireTestDatabaseUrl, servers, admFiles, events, kills, players, seasons, type Database } from "@factions/db";
import { sql } from "drizzle-orm";
import { PgLongRangeFeedStore } from "../src/long-range-feed-tick.js";

const URL = requireTestDatabaseUrl();
const A = "A".repeat(40); const B = "B".repeat(40); const R = "R".repeat(40);
const t0 = new Date("2026-09-12T00:00:00Z");
const s = (n: number) => new Date(t0.getTime() + n * 1000);

describe("PgLongRangeFeedStore", () => {
  let db: Database;
  let serverId: number;
  let store: PgLongRangeFeedStore;
  let line = 0;

  async function mkKill(a: { at: Date; killer: string | null; victim: string; distanceM?: number | null; ff?: boolean }) {
    const [file] = await db.select({ id: admFiles.id }).from(admFiles).where(sql`filename = 'f.ADM'`);
    const [ev] = await db.insert(events).values({
      serverId, admFileId: file!.id, lineIndex: line++, type: "player.killed" as never, occurredAt: a.at, payload: {},
    }).returning({ id: events.id });
    await db.insert(kills).values({
      serverId, eventId: ev!.id, occurredAt: a.at, victimDayzId: a.victim, killerDayzId: a.killer,
      weapon: "Mosin", distanceM: a.distanceM === undefined ? "340" : a.distanceM === null ? null : String(a.distanceM),
      cause: a.killer ? "pvp" : "died", friendlyFire: a.ff ?? false,
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
    store = new PgLongRangeFeedStore(db, { minM: 100 });
  });

  it("returns qualifying kills with their distance", async () => {
    await mkKill({ at: s(0), killer: A, victim: B, distanceM: 340 });
    const [item] = await store.readAfter(0, 20);
    expect(item!.distanceM).toBe(340);
    expect(item!.qualifies).toBe(true);
  });

  it("the threshold is inclusive", async () => {
    await mkKill({ at: s(0), killer: A, victim: B, distanceM: 100 });
    expect((await store.readAfter(0, 20))[0]!.qualifies).toBe(true);
  });

  it("a shorter kill comes back NOT qualifying, not absent — it still advances the cursor", async () => {
    await mkKill({ at: s(0), killer: A, victim: B, distanceM: 40 });
    const items = await store.readAfter(0, 20);
    expect(items).toHaveLength(1);
    expect(items[0]!.qualifies).toBe(false);
  });

  it("⚠️ a null distance is skipped, never read as zero — the log simply did not say", async () => {
    await mkKill({ at: s(0), killer: A, victim: B, distanceM: null });
    const items = await store.readAfter(0, 20);
    expect(items[0]!.distanceM).toBeNull();
    expect(items[0]!.qualifies).toBe(false);
  });

  it("marks a personal best, and stops marking it once beaten", async () => {
    await mkKill({ at: s(0), killer: A, victim: B, distanceM: 300 });
    await mkKill({ at: s(10), killer: A, victim: R, distanceM: 200 });
    const items = await store.readAfter(0, 20);
    expect(items[0]!.personalBest).toBe(true);
    expect(items[1]!.personalBest).toBe(false);
  });

  it("ranks within the season the kill belongs to", async () => {
    await db.insert(seasons).values({ serverId, number: 1, startedAt: s(-100), endedAt: null });
    await mkKill({ at: s(0), killer: A, victim: B, distanceM: 400 });
    await mkKill({ at: s(10), killer: R, victim: B, distanceM: 300 });
    const items = await store.readAfter(0, 20);
    expect(items[0]!.season).toBe(1);
    expect(items[0]!.seasonRank).toBe(1);
    expect(items[1]!.seasonRank).toBe(2);
  });

  it("⚠️ ranks numerically, not lexicographically — a 3-digit and a 4-digit distance would invert under string comparison", async () => {
    // "190" > "1400" lexicographically (first differing char '9' > '4'), but
    // 190 < 1400 numerically. Chosen specifically so a regression to string
    // comparison in the `further` clause flips BOTH assertions below: the
    // smaller kill would wrongly count as "further" than the larger one.
    await mkKill({ at: s(0), killer: A, victim: B, distanceM: 190 });
    await mkKill({ at: s(10), killer: A, victim: R, distanceM: 1400 });
    const items = await store.readAfter(0, 20);
    expect(items[0]!.personalBest).toBe(true);
    expect(items[0]!.seasonRank).toBe(1);
    // Under numeric comparison nothing outranks the 1400m kill. Under a
    // lexicographic comparison the earlier 190m kill would wrongly count as
    // "further", making this personalBest false and seasonRank 2.
    expect(items[1]!.personalBest).toBe(true);
    expect(items[1]!.seasonRank).toBe(1);
  });

  it("a kill before any season ranks all-time", async () => {
    await mkKill({ at: s(0), killer: A, victim: B, distanceM: 400 });
    expect((await store.readAfter(0, 20))[0]!.season).toBeNull();
  });

  it("⚠️ omits a rank past the cap — '17th longest' is not a highlight", async () => {
    for (let n = 0; n < 11; n++) await mkKill({ at: s(n), killer: A, victim: B, distanceM: 500 - n });
    const items = await store.readAfter(0, 20);
    expect(items[10]!.seasonRank).toBeNull();
  });

  it("friendly fire is included — a 400 m shot is remarkable regardless of who it hit", async () => {
    await mkKill({ at: s(0), killer: A, victim: B, distanceM: 400, ff: true });
    const [item] = await store.readAfter(0, 20);
    expect(item!.qualifies).toBe(true);
    expect(item!.friendlyFire).toBe(true);
  });

  it("head is the newest kill event id, and seeded is false until the cursor is written", async () => {
    const id = await mkKill({ at: s(0), killer: A, victim: B });
    expect(await store.head()).toBe(id);
    expect(await store.seeded()).toBe(false);
    await store.markPosted(id);
    expect(await store.seeded()).toBe(true);
  });
});
