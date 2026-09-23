import { describe, it, expect, beforeEach, vi } from "vitest";
import { createClient, runMigrations, requireTestDatabaseUrl, banAnnouncements, servers, type Database } from "@factions/db";
import { sql, eq } from "drizzle-orm";
import { banAnnounceTick, BAN_ANNOUNCE_BATCH_SIZE } from "../src/ban-announce-tick.js";

const URL = requireTestDatabaseUrl();
const at = (iso: string) => new Date(iso);

describe("banAnnounceTick", () => {
  let db: Database;
  let serverId = 0;
  let otherServerId = 0;

  beforeEach(async () => {
    db = createClient(URL);
    await runMigrations(db);
    await db.execute(sql`truncate table ban_announcements, servers restart identity cascade`);
    const [s] = await db.insert(servers).values({ name: "S", map: "livonia", clockOffsetMs: 0, nitradoServiceId: 1, active: true }).returning();
    serverId = s!.id;
    const [o] = await db.insert(servers).values({ name: "O", map: "livonia", clockOffsetMs: 0, nitradoServiceId: 2, active: true }).returning();
    otherServerId = o!.id;
  });

  async function insertRow(id: number, overrides: Partial<typeof banAnnouncements.$inferInsert> = {}) {
    // ⚠️ id is passed explicitly (bigserial column) so ordering tests can
    // insert out of id order while controlling occurredAt independently —
    // the tick must sort by id, never by occurredAt.
    await db.execute(sql`
      insert into ban_announcements (id, server_id, ban_id, kind, occurred_at, payload, posted_at)
      values (${id}, ${overrides.serverId ?? serverId}, null, ${overrides.kind ?? "applied"},
        ${(overrides.occurredAt ?? at("2026-09-17T00:00:00Z")).toISOString()},
        ${JSON.stringify({ gamertag: `P${id}`, reason: "zone", expiresAt: null })}::jsonb,
        ${overrides.postedAt ? overrides.postedAt.toISOString() : null})
    `);
    // restart the sequence so future inserts (without an explicit id) don't collide
    await db.execute(sql`select setval(pg_get_serial_sequence('ban_announcements', 'id'), (select max(id) from ban_announcements))`);
  }

  const postedIds = async () =>
    (await db.select({ id: banAnnouncements.id, postedAt: banAnnouncements.postedAt }).from(banAnnouncements))
      .filter((r) => r.postedAt !== null)
      .map((r) => r.id);

  it("posts nothing on an empty queue", async () => {
    const post = vi.fn().mockResolvedValue(undefined);
    const r = await banAnnounceTick(db, post, { now: at("2026-09-17T12:00:00Z"), serverId });
    expect(r).toEqual({ posted: 0, blockedAt: null });
    expect(post).not.toHaveBeenCalled();
  });

  it("posts rows oldest-first BY ID, not by occurredAt", async () => {
    // ⚠️ occurredAt deliberately disagrees with id order: row 3 has the
    // EARLIEST occurredAt but the HIGHEST id. If the tick ever sorted by
    // occurredAt (or used desc), row 3 would post first/last incorrectly.
    await insertRow(1, { occurredAt: at("2026-09-17T10:00:00Z") });
    await insertRow(2, { occurredAt: at("2026-09-17T11:00:00Z") });
    await insertRow(3, { occurredAt: at("2026-09-17T01:00:00Z") });

    const seen: string[] = [];
    const post = vi.fn(async (content: string) => { seen.push(content); });

    const r = await banAnnounceTick(db, post, { now: at("2026-09-17T12:00:00Z"), serverId });

    expect(r.posted).toBe(3);
    expect(r.blockedAt).toBeNull();
    expect(seen).toEqual([
      "🔨 **P1** banned permanently — base-zone enforcement.",
      "🔨 **P2** banned permanently — base-zone enforcement.",
      "🔨 **P3** banned permanently — base-zone enforcement.",
    ]);
    expect(await postedIds()).toEqual([1, 2, 3]);
  });

  it("renders each row by its own kind COLUMN, which the payload does not carry", async () => {
    // ⚠️ `announceTx` stores kind in the column and gamertag/reason/expiresAt
    // in the payload. Rendering the payload alone read kind as undefined, and
    // every unban posted to #bans as a second "banned until" line (2026-09-23,
    // the first hub-combat ban to expire). Every other test here queues the
    // default `applied`, which is why none of them could see it.
    await insertRow(1, { kind: "applied" });
    await insertRow(2, { kind: "expired" });
    await insertRow(3, { kind: "lifted" });

    const seen: string[] = [];
    const post = vi.fn(async (content: string) => { seen.push(content); });

    await banAnnounceTick(db, post, { now: at("2026-09-17T12:00:00Z"), serverId });

    expect(seen).toEqual([
      "🔨 **P1** banned permanently — base-zone enforcement.",
      "🔓 **P2** unbanned — ban served.",
      "🔓 **P3** unbanned.",
    ]);
  });

  it("does not re-post a row already marked posted", async () => {
    await insertRow(1, { postedAt: at("2026-09-16T00:00:00Z") });
    await insertRow(2);

    const post = vi.fn().mockResolvedValue(undefined);
    const r = await banAnnounceTick(db, post, { now: at("2026-09-17T12:00:00Z"), serverId });

    expect(r.posted).toBe(1);
    expect(post).toHaveBeenCalledTimes(1);
    expect(await postedIds()).toEqual([1, 2]);
  });

  it("stops at the first failure: earlier rows marked, the failing row not marked, later rows not posted", async () => {
    await insertRow(1);
    await insertRow(2);
    await insertRow(3);

    const post = vi.fn(async (content: string) => {
      if (content.includes("P2")) throw new Error("discord is down");
    });
    const onError = vi.fn();

    const r = await banAnnounceTick(db, post, { now: at("2026-09-17T12:00:00Z"), serverId, onError });

    expect(r.posted).toBe(1);
    expect(r.blockedAt).toBe(2);
    expect(post).toHaveBeenCalledTimes(2);
    expect(await postedIds()).toEqual([1]);
    expect(onError).toHaveBeenCalledTimes(1);
    expect(onError).toHaveBeenCalledWith(2, expect.any(Error));
  });

  it("respects batchSize", async () => {
    await insertRow(1);
    await insertRow(2);
    await insertRow(3);

    const post = vi.fn().mockResolvedValue(undefined);
    const r = await banAnnounceTick(db, post, { now: at("2026-09-17T12:00:00Z"), serverId, batchSize: 2 });

    expect(r.posted).toBe(2);
    expect(post).toHaveBeenCalledTimes(2);
    expect(await postedIds()).toEqual([1, 2]);
  });

  it("has a default batch size", () => {
    expect(BAN_ANNOUNCE_BATCH_SIZE).toBeGreaterThan(0);
  });

  it("does not post rows for a different serverId", async () => {
    await insertRow(1, { serverId: otherServerId });
    await insertRow(2, { serverId });

    const post = vi.fn().mockResolvedValue(undefined);
    const r = await banAnnounceTick(db, post, { now: at("2026-09-17T12:00:00Z"), serverId });

    expect(r.posted).toBe(1);
    expect(post).toHaveBeenCalledTimes(1);
    expect(await postedIds()).toEqual([2]);
  });
});
