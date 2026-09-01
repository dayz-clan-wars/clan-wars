import { describe, it, expect, beforeEach } from "vitest";
import { createClient, runMigrations, requireTestDatabaseUrl, players, servers, admFiles, type Database } from "@factions/db";
import { appendEvent, readCursor } from "@factions/event-log";
import type { EventType } from "@factions/domain";
import { sql, eq } from "drizzle-orm";
import { runPlayerProjection, PLAYER_CONSUMER } from "../src/player-tick.js";

const URL = requireTestDatabaseUrl();
const A = "A".repeat(40);

describe("runPlayerProjection", () => {
  let db: Database;
  let serverId = 0;
  let admFileId = 0;
  let line = 0;

  beforeEach(async () => {
    db = createClient(URL);
    await runMigrations(db);
    await db.execute(sql`truncate table events, raw_lines, adm_files, players, servers, consumer_cursors restart identity cascade`);
    const [s] = await db.insert(servers).values({ name: "S", map: "sakhal", clockOffsetMs: 0 }).returning();
    serverId = s!.id;
    const [f] = await db.insert(admFiles).values({ serverId, filename: "f.ADM", bootAt: new Date("2026-09-01T00:00:00Z") }).returning();
    admFileId = f!.id;
    line = 0;
  });

  const seedEvent = (input: { type: EventType; occurredAt: Date; payload: unknown }) =>
    appendEvent(db, {
      serverId, admFileId, lineIndex: line++, subIndex: 0,
      type: input.type, occurredAt: input.occurredAt, payload: input.payload,
    });

  it("records a player from a position event", async () => {
    await seedEvent({ type: "player.position", occurredAt: new Date("2026-09-01T10:00:00Z"),
      payload: { dayzId: A, gamertag: "Ronald", pos: { x: 1, y: 2, z: 3 } } });
    const r = await runPlayerProjection(db);
    expect(r.upserted).toBe(1);
    const [row] = await db.select().from(players).where(eq(players.dayzId, A));
    expect(row!.gamertag).toBe("Ronald");
    expect(row!.firstSeenAt.toISOString()).toBe("2026-09-01T10:00:00.000Z");
    expect(row!.lastSeenAt.toISOString()).toBe("2026-09-01T10:00:00.000Z");
  });

  it("advances last_seen and adopts a rename, keeping first_seen", async () => {
    await seedEvent({ type: "player.position", occurredAt: new Date("2026-09-01T10:00:00Z"),
      payload: { dayzId: A, gamertag: "Ronald", pos: { x: 1, y: 2, z: 3 } } });
    await runPlayerProjection(db);
    await seedEvent({ type: "emote.performed", occurredAt: new Date("2026-09-02T10:00:00Z"),
      payload: { dayzId: A, gamertag: "Renamed", emote: "EmoteClap", item: null } });
    await runPlayerProjection(db);
    const [row] = await db.select().from(players).where(eq(players.dayzId, A));
    expect(row!.gamertag).toBe("Renamed");
    expect(row!.firstSeenAt.toISOString()).toBe("2026-09-01T10:00:00.000Z");
    expect(row!.lastSeenAt.toISOString()).toBe("2026-09-02T10:00:00.000Z");
  });

  it("never moves last_seen backwards when events arrive out of order", async () => {
    // ⚠️ A backfill of old logs must not make a long-absent player look
    // recently active, and must not un-advance a player who IS active.
    await seedEvent({ type: "player.position", occurredAt: new Date("2026-09-05T10:00:00Z"),
      payload: { dayzId: A, gamertag: "Ronald", pos: { x: 1, y: 2, z: 3 } } });
    await runPlayerProjection(db);
    await seedEvent({ type: "player.position", occurredAt: new Date("2026-09-01T10:00:00Z"),
      payload: { dayzId: A, gamertag: "Older", pos: { x: 1, y: 2, z: 3 } } });
    await runPlayerProjection(db);
    const [row] = await db.select().from(players).where(eq(players.dayzId, A));
    expect(row!.lastSeenAt.toISOString()).toBe("2026-09-05T10:00:00.000Z");
    expect(row!.firstSeenAt.toISOString()).toBe("2026-09-01T10:00:00.000Z");
    // The gamertag follows the NEWEST event, so an older line must not rename them.
    expect(row!.gamertag).toBe("Ronald");
  });

  it("resumes from its own cursor and does not reprocess", async () => {
    await seedEvent({ type: "player.position", occurredAt: new Date("2026-09-01T10:00:00Z"),
      payload: { dayzId: A, gamertag: "Ronald", pos: { x: 1, y: 2, z: 3 } } });
    await runPlayerProjection(db);
    const second = await runPlayerProjection(db);
    expect(second.scanned).toBe(0);
    expect(await readCursor(db, PLAYER_CONSUMER)).toBeGreaterThan(0);
  });

  it("skips event types that carry no dayzId/gamertag payload, without counting them as upserted", async () => {
    await seedEvent({ type: "player.position", occurredAt: new Date("2026-09-01T10:00:00Z"),
      payload: { dayzId: A, gamertag: "Ronald", pos: { x: 1, y: 2, z: 3 } } });
    await seedEvent({ type: "flag.raised", occurredAt: new Date("2026-09-01T10:05:00Z"),
      payload: { factionId: 1 } });
    const r = await runPlayerProjection(db);
    expect(r.scanned).toBe(1);
    expect(r.upserted).toBe(1);
  });

  it("is correct when one batch contains two events for the same dayzId", async () => {
    await seedEvent({ type: "player.position", occurredAt: new Date("2026-09-01T10:00:00Z"),
      payload: { dayzId: A, gamertag: "Ronald", pos: { x: 1, y: 2, z: 3 } } });
    await seedEvent({ type: "emote.performed", occurredAt: new Date("2026-09-01T11:00:00Z"),
      payload: { dayzId: A, gamertag: "Renamed", emote: "EmoteClap", item: null } });
    const r = await runPlayerProjection(db);
    expect(r.upserted).toBe(2);
    const [row] = await db.select().from(players).where(eq(players.dayzId, A));
    expect(row!.gamertag).toBe("Renamed");
    expect(row!.firstSeenAt.toISOString()).toBe("2026-09-01T10:00:00.000Z");
    expect(row!.lastSeenAt.toISOString()).toBe("2026-09-01T11:00:00.000Z");
  });
});
