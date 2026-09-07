import { describe, it, expect, beforeEach } from "vitest";
import { createClient, runMigrations, requireTestDatabaseUrl, servers, admFiles, events, playerSessions, type Database } from "@factions/db";
import { sql } from "drizzle-orm";
import { sessionsTick, rebuildSessions } from "../src/sessions-tick.js";

const URL = requireTestDatabaseUrl();
const t0 = new Date("2026-09-07T12:00:00Z");
const FOUR_HOURS_MS = 4 * 60 * 60 * 1000;
const UID = "A".repeat(40);
const UID2 = "B".repeat(40);

describe("sessionsTick", () => {
  let db: Database; let serverId = 0; let file1 = 0; let file2 = 0; let line = 0;
  beforeEach(async () => {
    db = createClient(URL);
    await runMigrations(db);
    await db.execute(sql`truncate table player_sessions, events, raw_lines, adm_files, consumer_cursors, servers restart identity cascade`);
    const [s] = await db.insert(servers).values({ name: "S", map: "livonia", clockOffsetMs: 0 }).returning();
    serverId = s!.id;
    const [a1] = await db.insert(admFiles).values({ serverId, filename: "f1.ADM", bootAt: t0, linesIngested: 0, complete: true }).returning();
    file1 = a1!.id;
    const [a2] = await db.insert(admFiles).values({ serverId, filename: "f2.ADM", bootAt: new Date(t0.getTime() + FOUR_HOURS_MS), linesIngested: 0, complete: true }).returning();
    file2 = a2!.id;
    line = 0;
  });

  const evOn = (sid: number, admFileId: number, type: string, payload: unknown, at: Date) =>
    db.insert(events).values({ serverId: sid, admFileId, lineIndex: line++, type: type as never, occurredAt: at, payload }).returning({ id: events.id });

  const ev = (admFileId: number, type: string, payload: unknown, at: Date) => evOn(serverId, admFileId, type, payload, at);

  it("1. connect then disconnect closes the session with close_reason 'disconnect'", async () => {
    const [c] = await ev(file1, "player.connected", { dayzId: UID, gamertag: "A" }, new Date(t0.getTime() + 60_000));
    await ev(file1, "player.disconnected", { dayzId: UID, gamertag: "A" }, new Date(t0.getTime() + 30 * 60_000));
    await sessionsTick(db);
    const rows = await db.select().from(playerSessions);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.connectEventId).toBe(c!.id);
    expect(rows[0]!.closeReason).toBe("disconnect");
    expect(rows[0]!.disconnectedAt).toEqual(new Date(t0.getTime() + 30 * 60_000));
  });

  it("2. an open session across a file boundary is closed 'restart' at the new file's boot_at", async () => {
    await ev(file1, "player.connected", { dayzId: UID, gamertag: "A" }, new Date(t0.getTime() + 60_000));
    // No disconnect in file 1. First event of file 2 is any type (a position-like event).
    await ev(file2, "player.position", { dayzId: UID, gamertag: "A", pos: { x: 1, y: 2, z: 3 } }, new Date(t0.getTime() + FOUR_HOURS_MS + 60_000));
    const result = await sessionsTick(db);
    expect(result.restarted).toBe(1);
    const rows = await db.select().from(playerSessions);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.closeReason).toBe("restart");
    expect(rows[0]!.disconnectedAt).toEqual(new Date(t0.getTime() + FOUR_HOURS_MS));
  });

  it("3. a disconnect with no open session writes nothing; a second connect while one is open closes the first as 'restart' at the new connect instant", async () => {
    await ev(file1, "player.disconnected", { dayzId: UID2, gamertag: "B" }, new Date(t0.getTime() + 60_000));
    const r1 = await sessionsTick(db);
    expect(r1.closed).toBe(0);
    expect(await db.select().from(playerSessions)).toHaveLength(0);

    const [c1] = await ev(file1, "player.connected", { dayzId: UID, gamertag: "A" }, new Date(t0.getTime() + 2 * 60_000));
    const [c2] = await ev(file1, "player.connected", { dayzId: UID, gamertag: "A" }, new Date(t0.getTime() + 5 * 60_000));
    await sessionsTick(db);
    const rows = await db.select().from(playerSessions).orderBy(playerSessions.id);
    expect(rows).toHaveLength(2);
    expect(rows[0]!.connectEventId).toBe(c1!.id);
    expect(rows[0]!.closeReason).toBe("restart");
    expect(rows[0]!.disconnectedAt).toEqual(new Date(t0.getTime() + 5 * 60_000));
    expect(rows[1]!.connectEventId).toBe(c2!.id);
    expect(rows[1]!.closeReason).toBeNull();
    expect(rows[1]!.disconnectedAt).toBeNull();
  });

  it("4. replay (cursor reset) writes no second row and does not re-close", async () => {
    await ev(file1, "player.connected", { dayzId: UID, gamertag: "A" }, new Date(t0.getTime() + 60_000));
    await ev(file1, "player.disconnected", { dayzId: UID, gamertag: "A" }, new Date(t0.getTime() + 30 * 60_000));
    await sessionsTick(db);
    const before = await db.select().from(playerSessions);
    await db.execute(sql`update consumer_cursors set last_event_id = 0`);
    await sessionsTick(db);
    const after = await db.select().from(playerSessions);
    expect(after).toEqual(before);
  });

  it("5. rebuildSessions reproduces the same rows from scratch", async () => {
    await ev(file1, "player.connected", { dayzId: UID, gamertag: "A" }, new Date(t0.getTime() + 60_000));
    await ev(file1, "player.disconnected", { dayzId: UID, gamertag: "A" }, new Date(t0.getTime() + 30 * 60_000));
    await ev(file1, "player.connected", { dayzId: UID2, gamertag: "B" }, new Date(t0.getTime() + 2 * 60_000));
    await ev(file2, "player.position", { dayzId: UID2, gamertag: "B", pos: { x: 1, y: 2, z: 3 } }, new Date(t0.getTime() + FOUR_HOURS_MS + 60_000));
    await sessionsTick(db);
    const strip = (rows: (typeof playerSessions.$inferSelect)[]) =>
      rows.map(({ id, ...rest }) => rest).sort((a, b) => a.connectedAt.getTime() - b.connectedAt.getTime());
    const before = strip(await db.select().from(playerSessions));

    const written = await rebuildSessions(db, serverId);
    expect(written).toBe(before.length);
    const after = strip(await db.select().from(playerSessions));
    expect(after).toEqual(before);
  });

  it("6. a file boundary that straddles two ticks still closes the session: the seed, not the in-memory map", async () => {
    // ⚠️ The whole point of the seed query. Tick one sees file 1 only, so the
    // in-memory `lastFileByServer` map is thrown away with nothing to compare
    // against; tick two must learn "the last file this server was in was file
    // 1" from `player_sessions ⋈ events` or the restart-close never fires.
    await ev(file1, "player.connected", { dayzId: UID, gamertag: "A" }, new Date(t0.getTime() + 60_000));
    const first = await sessionsTick(db);
    expect(first.opened).toBe(1);
    expect(first.restarted).toBe(0);
    expect((await db.select().from(playerSessions))[0]!.disconnectedAt).toBeNull();

    // A separate tick, with only file 2's first event to go on.
    await ev(file2, "player.position", { dayzId: UID, gamertag: "A", pos: { x: 1, y: 2, z: 3 } }, new Date(t0.getTime() + FOUR_HOURS_MS + 60_000));
    const second = await sessionsTick(db);
    expect(second.restarted).toBe(1);

    const rows = await db.select().from(playerSessions);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.closeReason).toBe("restart");
    expect(rows[0]!.disconnectedAt).toEqual(new Date(t0.getTime() + FOUR_HOURS_MS));
  });

  it("7. two servers in one batch each cross their own file boundary and close only their own sessions", async () => {
    const [s2] = await db.insert(servers).values({ name: "S2", map: "livonia", clockOffsetMs: 0 }).returning();
    const serverId2 = s2!.id;
    const SIX_HOURS_MS = 6 * 60 * 60 * 1000;
    const [b1] = await db.insert(admFiles).values({ serverId: serverId2, filename: "g1.ADM", bootAt: t0, linesIngested: 0, complete: true }).returning();
    const [b2] = await db.insert(admFiles).values({ serverId: serverId2, filename: "g2.ADM", bootAt: new Date(t0.getTime() + SIX_HOURS_MS), linesIngested: 0, complete: true }).returning();

    // Interleaved in one batch. The two servers boot their second file at
    // different instants, so a cross-server close would land the wrong
    // `disconnected_at` rather than merely the wrong count.
    await evOn(serverId, file1, "player.connected", { dayzId: UID, gamertag: "A" }, new Date(t0.getTime() + 60_000));
    await evOn(serverId2, b1!.id, "player.connected", { dayzId: UID, gamertag: "A" }, new Date(t0.getTime() + 2 * 60_000));
    await evOn(serverId2, b1!.id, "player.connected", { dayzId: UID2, gamertag: "B" }, new Date(t0.getTime() + 3 * 60_000));
    await evOn(serverId, file2, "player.position", { dayzId: UID, gamertag: "A", pos: { x: 1, y: 2, z: 3 } }, new Date(t0.getTime() + FOUR_HOURS_MS + 60_000));
    await evOn(serverId2, b2!.id, "player.connected", { dayzId: UID2, gamertag: "B" }, new Date(t0.getTime() + SIX_HOURS_MS + 60_000));

    const result = await sessionsTick(db);
    expect(result.opened).toBe(4);
    expect(result.closed).toBe(0);
    expect(result.restarted).toBe(3);

    const rows = await db.select().from(playerSessions).orderBy(playerSessions.id);
    expect(rows).toHaveLength(4);
    const [one, two, three, four] = rows;
    expect(one!.serverId).toBe(serverId);
    expect(one!.disconnectedAt).toEqual(new Date(t0.getTime() + FOUR_HOURS_MS));
    expect(one!.closeReason).toBe("restart");
    expect(two!.serverId).toBe(serverId2);
    expect(two!.disconnectedAt).toEqual(new Date(t0.getTime() + SIX_HOURS_MS));
    expect(three!.serverId).toBe(serverId2);
    expect(three!.disconnectedAt).toEqual(new Date(t0.getTime() + SIX_HOURS_MS));
    expect(four!.serverId).toBe(serverId2);
    expect(four!.disconnectedAt).toBeNull();
  });
});
