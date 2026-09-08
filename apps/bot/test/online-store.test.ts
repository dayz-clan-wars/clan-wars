import { describe, it, expect, beforeEach } from "vitest";
import { createClient, runMigrations, requireTestDatabaseUrl, servers, players, playerSessions, membershipHistory, admFiles, events, type Database } from "@factions/db";
import { sql } from "drizzle-orm";
import { seedFaction } from "./seed.js";
import { PgOnlineStore } from "../src/online-tick.js";

const URL = requireTestDatabaseUrl();
const A = "A".repeat(40); const B = "B".repeat(40); const N = "N".repeat(40);
const t0 = new Date("2026-09-08T12:00:00Z");
const h = (n: number) => new Date(t0.getTime() + n * 3600_000);

describe("PgOnlineStore", () => {
  let db: Database;
  let serverId: number;
  let line = 0;

  /** A session whose connect event exists, the way the schema requires. */
  async function mkSession(a: { dayzId: string; from: Date; to?: Date | null }) {
    const [file] = await db.select({ id: admFiles.id }).from(admFiles).where(sql`filename = 'f.ADM'`);
    const [ev] = await db.insert(events).values({ serverId, admFileId: file!.id, lineIndex: line++, type: "player.connected" as never, occurredAt: a.from, payload: {} }).returning({ id: events.id });
    await db.insert(playerSessions).values({
      serverId, dayzId: a.dayzId, connectedAt: a.from, connectEventId: ev!.id,
      disconnectedAt: a.to ?? null, closeReason: a.to ? "disconnect" : null,
    });
  }

  beforeEach(async () => {
    db = createClient(URL);
    await runMigrations(db);
    await db.execute(sql`truncate table player_sessions, players, membership_history, declarations, poles, factions, events, raw_lines, adm_files, servers restart identity cascade`);
    const [s] = await db.insert(servers).values({ name: "S", map: "livonia", clockOffsetMs: 0 }).returning();
    serverId = s!.id;
    line = 0;
    await db.insert(admFiles).values({ serverId, filename: "f.ADM", bootAt: t0, linesIngested: 0, complete: true });
    await db.insert(players).values([
      { dayzId: A, gamertag: "Alpha", firstSeenAt: t0, lastSeenAt: t0 }, { dayzId: B, gamertag: "Bravo", firstSeenAt: t0, lastSeenAt: t0 },
    ]);
  });

  it("is the open sessions, oldest connect first, with the log's name and the clan of now", async () => {
    const bear = await seedFaction(db, { serverId, tag: "BEAR", texture: "Flag_Bear", createdAt: t0 });
    const wolf = await seedFaction(db, { serverId, tag: "WOLF", texture: "Flag_Wolf", createdAt: t0, poleKey: "8000.00:100.00:8000.00", x: 8000, z: 8000 });
    // A was in WOLF, left, and is in BEAR now: the open span is what shows.
    await db.insert(membershipHistory).values([
      { serverId, factionId: wolf.id, dayzId: A, joinedAt: h(-48), leftAt: h(-24) },
      { serverId, factionId: bear.id, dayzId: A, joinedAt: h(-24), leftAt: null },
    ]);
    await mkSession({ dayzId: A, from: h(1) });
    await mkSession({ dayzId: B, from: h(0) });
    await mkSession({ dayzId: N, from: h(2) });
    await mkSession({ dayzId: A, from: h(-5), to: h(-4) });
    expect(await new PgOnlineStore(db).read()).toEqual([
      { dayzId: B, gamertag: "Bravo", tag: null, connectedAt: h(0) },
      { dayzId: A, gamertag: "Alpha", tag: "BEAR", connectedAt: h(1) },
      { dayzId: N, gamertag: "Unknown", tag: null, connectedAt: h(2) },
    ]);
  });

  it("is empty when every session is closed", async () => {
    await mkSession({ dayzId: A, from: h(-5), to: h(-4) });
    expect(await new PgOnlineStore(db).read()).toEqual([]);
  });
});
