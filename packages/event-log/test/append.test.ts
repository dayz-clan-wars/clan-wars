import { describe, it, expect, beforeAll } from "vitest";
import { createClient, runMigrations, requireTestDatabaseUrl, servers, admFiles, events, type Database } from "@factions/db";
import { sql, eq } from "drizzle-orm";
import { appendEvent, readCursor, writeCursor } from "../src/index.js";

const URL = requireTestDatabaseUrl();

describe("event log", () => {
  let db: Database;
  let serverId: number;
  let admFileId: number;

  beforeAll(async () => {
    db = createClient(URL);
    await runMigrations(db);
    await db.execute(sql`truncate table flag_changes, poles, events, raw_lines, adm_files, servers, consumer_cursors restart identity cascade`);
    const [srv] = await db.insert(servers).values({ name: "T", map: "livonia", clockOffsetMs: 0 }).returning();
    serverId = srv!.id;
    const [f] = await db.insert(admFiles).values({
      serverId, filename: "a.ADM", bootAt: new Date("2026-07-22T07:01:37Z"),
    }).returning();
    admFileId = f!.id;
  });

  const input = {
    serverId: 0, admFileId: 0, lineIndex: 5, subIndex: 0,
    type: "flag.raised" as const,
    occurredAt: new Date("2026-07-22T07:52:16Z"),
    payload: { texture: "Flag_Livonia" },
  };

  it("appends an event", async () => {
    await appendEvent(db, { ...input, serverId, admFileId });
    const rows = await db.select().from(events).where(eq(events.serverId, serverId));
    expect(rows).toHaveLength(1);
    expect(rows[0]?.type).toBe("flag.raised");
  });

  it("is idempotent on the (server, file, line, sub) key", async () => {
    await appendEvent(db, { ...input, serverId, admFileId });
    await appendEvent(db, { ...input, serverId, admFileId });
    const rows = await db.select().from(events).where(eq(events.serverId, serverId));
    expect(rows).toHaveLength(1);
  });

  it("treats a different subIndex as a distinct event", async () => {
    await appendEvent(db, { ...input, serverId, admFileId, subIndex: 1, type: "player.position" });
    const rows = await db.select().from(events).where(eq(events.serverId, serverId));
    expect(rows).toHaveLength(2);
  });

  it("returns 0 for an unknown consumer cursor", async () => {
    expect(await readCursor(db, "nobody")).toBe(0);
  });

  it("round-trips a cursor", async () => {
    await writeCursor(db, "projector", 42);
    expect(await readCursor(db, "projector")).toBe(42);
  });

  it("overwrites an existing cursor", async () => {
    await writeCursor(db, "projector", 99);
    expect(await readCursor(db, "projector")).toBe(99);
  });

  // Deviation from brief: appendEvent returns Promise<boolean> (true = row inserted,
  // false = idempotency conflict suppressed the insert), not Promise<void>.
  describe("appendEvent return value", () => {
    const key = {
      serverId: 0, admFileId: 0, lineIndex: 20, subIndex: 0,
      type: "flag.raised" as const,
      occurredAt: new Date("2026-07-22T07:52:16Z"),
      payload: { texture: "Flag_Livonia" },
    };

    it("returns true for a fresh append", async () => {
      const result = await appendEvent(db, { ...key, serverId, admFileId });
      expect(result).toBe(true);
    });

    it("returns false when the idempotency key already exists", async () => {
      const result = await appendEvent(db, { ...key, serverId, admFileId });
      expect(result).toBe(false);
    });

    it("still holds exactly one row for that key after both calls", async () => {
      const rows = await db.select().from(events).where(
        sql`${events.serverId} = ${serverId} and ${events.lineIndex} = ${key.lineIndex} and ${events.subIndex} = ${key.subIndex}`,
      );
      expect(rows).toHaveLength(1);
    });
  });
});
