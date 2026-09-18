import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import {
  createClient, runMigrations, requireTestDatabaseUrl,
  servers, admFiles, events, players, identityLinks, seasons, kills,
  type Database,
} from "@factions/db";
import { sql } from "drizzle-orm";
import { PgCrownStore } from "../src/crown-store.js";

const URL = requireTestDatabaseUrl();

/** Season 1 runs t0 → t50 (closed); season 2 is open from t50, so it is "current". */
const t0 = new Date("2026-01-01T00:00:00Z");
const t50 = new Date("2026-03-01T00:00:00Z");
const now = new Date("2026-06-01T12:00:00Z");
const HOUR = 3_600_000;
const h = (base: Date, n: number) => new Date(base.getTime() + n * HOUR);

const A = "dayz-A";
const B = "dayz-B";
const N = "dayz-N"; // never linked their Discord account
const V = "dayz-V"; // victim

describe("PgCrownStore", () => {
  let db: Database;
  let store: PgCrownStore;
  let serverId = 0;
  let admFileId = 0;
  let lineIndex = 0;

  const mkKill = async (a: { at: Date; victim: string; killer: string; friendlyFire?: boolean }) => {
    const [ev] = await db.insert(events).values({
      serverId, admFileId, lineIndex: lineIndex++, type: "player.killed" as never, occurredAt: a.at, payload: {},
    }).returning();
    await db.insert(kills).values({
      serverId, eventId: ev!.id, occurredAt: a.at, victimDayzId: a.victim, killerDayzId: a.killer,
      weapon: null, distanceM: null, cause: "pvp", friendlyFire: a.friendlyFire ?? false,
    });
  };

  const killsBy = async (killer: string, n: number, at: Date) => {
    for (let i = 1; i <= n; i++) await mkKill({ at: h(at, i), victim: V, killer });
  };

  // ⚠️ One client for the file: a `createClient` per test leaks its pool.
  beforeAll(async () => {
    db = createClient(URL);
    await runMigrations(db);
  });

  beforeEach(async () => {
    await db.transaction(async (tx) => {
      await tx.execute(sql`set local client_min_messages = warning`);
      await tx.execute(sql`truncate table kills, player_sessions, membership_history, clan_pins, intruder_sightings, player_positions, clan_notices, war_log_events, season_results, alpha_weeks, defenses, season_standings, raids, seasons, faction_events, faction_members, declarations, poles, identity_links, consumer_cursors, events, raw_lines, adm_files, factions, players, servers restart identity cascade`);
    });
    const [s] = await db.insert(servers).values({ name: "S", map: "livonia", clockOffsetMs: 0, active: true }).returning();
    serverId = s!.id;
    const [f] = await db.insert(admFiles).values({ serverId, filename: "f.ADM", bootAt: t0, linesIngested: 0, complete: true }).returning();
    admFileId = f!.id;
    lineIndex = 0;

    await db.insert(seasons).values([
      { serverId, number: 1, startedAt: t0, endedAt: t50 },
      { serverId, number: 2, startedAt: t50, endedAt: null },
    ]);
    await db.insert(players).values([
      { dayzId: A, gamertag: "Alpha", firstSeenAt: t0, lastSeenAt: t50 },
      { dayzId: B, gamertag: "Bravo", firstSeenAt: t0, lastSeenAt: t50 },
      { dayzId: N, gamertag: "November", firstSeenAt: t0, lastSeenAt: t50 },
      { dayzId: V, gamertag: "Victim", firstSeenAt: t0, lastSeenAt: t50 },
    ]);
    await db.insert(identityLinks).values([
      { discordId: "dA", dayzId: A, gamertag: "Alpha", verifiedAt: t0 },
      { discordId: "dB", dayzId: B, gamertag: "Bravo", verifiedAt: t0 },
    ]);
    store = new PgCrownStore(db, () => now);
  });

  it("hands the crown to the #1, as a Discord id", async () => {
    await killsBy(A, 3, t50);
    await killsBy(B, 1, h(t50, 10));
    const holders = await store.topHolders();
    expect(holders.get("killers")).toEqual(new Set(["dA"]));
  });

  it("hands it to every player tied at the top value", async () => {
    await killsBy(A, 3, t50);
    await killsBy(B, 3, h(t50, 10));
    const holders = await store.topHolders();
    expect(holders.get("killers")).toEqual(new Set(["dA", "dB"]));
  });

  it("⚠️ leaves the crown unheld when the #1 never linked Discord — #2 does not inherit it", async () => {
    await killsBy(N, 5, t50);
    await killsBy(A, 1, h(t50, 10));
    const holders = await store.topHolders();
    expect(holders.get("killers")).toBeUndefined();
  });

  it("counts only the current season", async () => {
    await killsBy(A, 5, t0); // season 1, closed
    await killsBy(B, 1, h(t50, 10)); // season 2, current
    const holders = await store.topHolders();
    expect(holders.get("killers")).toEqual(new Set(["dB"]));
  });

  it("has no holder for a board nobody is on", async () => {
    await killsBy(A, 2, t50);
    const holders = await store.topHolders();
    expect(holders.get("friendlyFire")).toBeUndefined();
    expect(holders.get("raiders")).toBeUndefined();
    expect(holders.get("builders")).toBeUndefined();
  });

  it("reads every board in one pass", async () => {
    await killsBy(A, 2, t50);
    await mkKill({ at: h(t50, 20), victim: B, killer: A, friendlyFire: true });
    const holders = await store.topHolders();
    expect(holders.get("killers")).toEqual(new Set(["dA"]));
    expect(holders.get("friendlyFire")).toEqual(new Set(["dA"]));
    // V is the most-killed by a distance, and V is unlinked, so the deaths
    // crown goes unheld rather than down to B.
    expect(holders.get("deaths")).toBeUndefined();
  });
});
