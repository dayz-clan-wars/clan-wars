import { describe, it, expect, beforeEach } from "vitest";
import { createClient, runMigrations, requireTestDatabaseUrl, servers, admFiles, events, playerPositions, type Database } from "@factions/db";
import { sql } from "drizzle-orm";
import { POSITION_RETENTION_MS } from "@factions/domain";
import { positionsTick } from "../src/positions-tick.js";

const URL = requireTestDatabaseUrl();
const now = new Date("2026-09-07T12:00:00Z");
const UID = "A".repeat(40);

describe("positionsTick", () => {
  let db: Database; let serverId = 0; let admFileId = 0; let line = 0;
  beforeEach(async () => {
    db = createClient(URL);
    await runMigrations(db);
    await db.execute(sql`truncate table player_positions, events, raw_lines, adm_files, consumer_cursors, servers restart identity cascade`);
    const [s] = await db.insert(servers).values({ name: "S", map: "livonia", clockOffsetMs: 0 }).returning();
    serverId = s!.id;
    const [a] = await db.insert(admFiles).values({ serverId, filename: "f.ADM", bootAt: now, linesIngested: 0, complete: true }).returning();
    admFileId = a!.id; line = 0;
  });
  const ev = (type: string, payload: unknown, at = now) =>
    db.insert(events).values({ serverId, admFileId, lineIndex: line++, type: type as never, occurredAt: at, payload }).returning({ id: events.id });

  it("projects every pos-bearing event, x/z/alt in their places, and is idempotent by event id", async () => {
    await ev("player.position", { dayzId: UID, gamertag: "A", pos: { x: 100.5, y: 7, z: 200.25 } });
    await ev("base.built", { dayzId: UID, gamertag: "A", action: "built", part: "gate", structure: "Fence", tool: null, pos: { x: 101, y: 7, z: 201 } }, new Date(now.getTime() + 1000));
    await ev("emote.performed", { dayzId: UID, gamertag: "A", emote: "EmoteSitA", item: null });
    expect(await positionsTick(db, { now })).toEqual({ scanned: 2, written: 2 });
    const rows = await db.select().from(playerPositions);
    expect(rows.map((r) => [Number(r.x), Number(r.z), Number(r.alt)])).toEqual([[100.5, 200.25, 7], [101, 201, 7]]);
    expect(await positionsTick(db, { now })).toEqual({ scanned: 0, written: 0 });
  });

  it("a replayed event (cursor reset) writes nothing twice", async () => {
    await ev("player.position", { dayzId: UID, gamertag: "A", pos: { x: 1, y: 2, z: 3 } });
    await positionsTick(db, { now });
    await db.execute(sql`update consumer_cursors set last_event_id = 0`);
    expect((await positionsTick(db, { now })).written).toBe(0);
    expect(await db.select().from(playerPositions)).toHaveLength(1);
  });

  it("⚠️ a fix older than POSITION_RETENTION_MS is not written (the reaper would delete it within five minutes); one inside the window is", async () => {
    await ev("player.position", { dayzId: UID, gamertag: "A", pos: { x: 1, y: 2, z: 3 } }, new Date(now.getTime() - POSITION_RETENTION_MS - 60_000));
    expect(await positionsTick(db, { now })).toEqual({ scanned: 0, written: 0 });
    expect(await db.select().from(playerPositions)).toHaveLength(0);

    await ev("player.position", { dayzId: UID, gamertag: "A", pos: { x: 4, y: 5, z: 6 } }, new Date(now.getTime() - POSITION_RETENTION_MS + 60_000));
    expect(await positionsTick(db, { now })).toEqual({ scanned: 1, written: 1 });
    expect(await db.select().from(playerPositions)).toHaveLength(1);
  });
});
