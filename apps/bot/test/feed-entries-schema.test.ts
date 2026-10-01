import { describe, it, expect, beforeEach } from "vitest";
import { createClient, runMigrations, requireTestDatabaseUrl, servers, admFiles, events, feedEntries, type Database } from "@factions/db";
import { LIVE_ENTRY_KINDS } from "@factions/domain";
import { sql } from "drizzle-orm";

const URL = requireTestDatabaseUrl();
const t0 = new Date("2026-09-08T00:00:00Z");

describe("feed_entries", () => {
  let db: Database;
  let serverId: number;
  let eventId: number;

  beforeEach(async () => {
    db = createClient(URL);
    await runMigrations(db);
    await db.execute(sql`truncate table feed_entries, events, raw_lines, adm_files, servers restart identity cascade`);
    const [s] = await db.insert(servers).values({ name: "S", map: "livonia", clockOffsetMs: 0 }).returning();
    serverId = s!.id;
    const [f] = await db.insert(admFiles).values({ serverId, filename: "f.ADM", bootAt: t0, linesIngested: 0, complete: true }).returning();
    const [e] = await db.insert(events).values({ serverId, admFileId: f!.id, lineIndex: 0, type: "player.killed" as never, occurredAt: t0, payload: {} }).returning({ id: events.id });
    eventId = e!.id;
  });

  const row = (payload: unknown, kind = "kill") => ({ serverId, kind: kind as never, sourceEventId: eventId, occurredAt: t0, payload });

  it("accepts a payload with no positions", async () => {
    await db.insert(feedEntries).values(row({ killer: { gamertag: "A", tag: null, texture: null }, hits: [{ damage: 30, bodyPart: "Torso", weapon: "KA-74", distanceM: 41 }] }));
    const rows = await db.select().from(feedEntries);
    expect(rows).toHaveLength(1);
  });

  it.each(["pos", "victimPos", "attackerPos", "killerPos", "poleKey", "x", "y", "z"])("rejects a %s key at the top level", async (k) => {
    await expect(db.insert(feedEntries).values(row({ [k]: 1 }))).rejects.toThrow(/feed_entries_no_coordinates/u);
  });

  it("rejects a position key nested inside a hit line", async () => {
    await expect(db.insert(feedEntries).values(row({ hits: [{ damage: 1, victimPos: [1, 2, 3] }] }))).rejects.toThrow(/feed_entries_no_coordinates/u);
  });

  it("does not trip on a gamertag that merely spells a key", async () => {
    await db.insert(feedEntries).values(row({ killer: { gamertag: "\"x\": 1", tag: "x", texture: null } }));
    expect(await db.select().from(feedEntries)).toHaveLength(1);
  });

  // ⚠️ LIVE_ENTRY_KINDS and the CHECK's SQL literal are two statements of one
  // fact. A kind added to the TypeScript list but not the constraint compiles,
  // passes every unit test, and fails at runtime on the first insert.
  it("the kind CHECK enumerates exactly LIVE_ENTRY_KINDS", async () => {
    const rows = await db.execute(sql`select pg_get_constraintdef(oid) as def from pg_constraint where conname = 'feed_entries_kind_valid'`);
    const def = (rows as unknown as { def: string }[])[0]?.def;
    expect(def).toBeDefined();
    const kinds = [...def!.matchAll(/'([a-z_]+)'/gu)].map((m) => m[1]);
    expect(new Set(kinds)).toEqual(new Set(LIVE_ENTRY_KINDS));
    expect(kinds).toHaveLength(LIVE_ENTRY_KINDS.length);
  });

  it("rejects an unknown kind", async () => {
    await expect(db.insert(feedEntries).values(row({}, "raid"))).rejects.toThrow(/feed_entries_kind_valid/u);
  });

  it("is unique on (kind, source_event_id) so a re-run cannot double-write", async () => {
    await db.insert(feedEntries).values(row({}));
    await db.insert(feedEntries).values(row({})).onConflictDoNothing();
    expect(await db.select().from(feedEntries)).toHaveLength(1);
    // A different kind for the same kill is a separate entry (a kill can also be a streak milestone).
    await db.insert(feedEntries).values(row({}, "killstreak"));
    expect(await db.select().from(feedEntries)).toHaveLength(2);
  });

  it("deleting the source event deletes its entry: a hand-deleted misparse takes its website row with it", async () => {
    await db.insert(feedEntries).values(row({}));
    await db.delete(events).where(sql`id = ${eventId}`);
    expect(await db.select().from(feedEntries)).toHaveLength(0);
  });
});
