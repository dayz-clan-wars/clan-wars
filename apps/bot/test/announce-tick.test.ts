import { describe, it, expect, beforeEach, vi } from "vitest";
import { createClient, runMigrations, requireTestDatabaseUrl, vehicleWipeAnnouncements, type Database } from "@factions/db";
import { sql } from "drizzle-orm";
import { announceTick } from "../src/announce-tick.js";

const URL = requireTestDatabaseUrl();
const at = (iso: string) => new Date(iso);

describe("announceTick", () => {
  let db: Database;
  beforeEach(async () => {
    db = createClient(URL);
    await runMigrations(db);
    await db.execute(sql`truncate table vehicle_wipe_announcements`);
  });
  const rows = () => db.select().from(vehicleWipeAnnouncements);

  it("posts at the announce moment, naming this week's vehicle", async () => {
    const post = vi.fn(async (_content: string) => {});
    const r = await announceTick(db, post, { now: at("2026-09-13T08:00:01Z"), offHour: 8 });
    expect(r).toEqual({ posted: 1, missed: 0, failed: 0 });
    expect(post).toHaveBeenCalledTimes(1);
    expect(post.mock.calls[0]![0]).toContain("Olga");
    expect(await rows()).toMatchObject([
      { wipeAt: at("2026-09-14T08:00:00Z"), eventName: "VehicleCivilianSedan", outcome: "posted" },
    ]);
  });

  it("posts exactly once, however many ticks run", async () => {
    const post = vi.fn(async (_content: string) => {});
    await announceTick(db, post, { now: at("2026-09-13T08:00:01Z"), offHour: 8 });
    await announceTick(db, post, { now: at("2026-09-13T08:00:11Z"), offHour: 8 });
    await announceTick(db, post, { now: at("2026-09-13T20:00:00Z"), offHour: 8 });
    expect(post).toHaveBeenCalledTimes(1);
    expect(await rows()).toHaveLength(1);
  });

  it("stays silent before the announce moment", async () => {
    const post = vi.fn(async (_content: string) => {});
    const r = await announceTick(db, post, { now: at("2026-09-13T07:59:00Z"), offHour: 8 });
    expect(r).toEqual({ posted: 0, missed: 0, failed: 0 });
    expect(post).not.toHaveBeenCalled();
    expect(await rows()).toEqual([]);
  });

  // ⚠️ Catch-up: a bot that was down all Sunday morning should still give notice.
  it("catches up late on the Sunday", async () => {
    const post = vi.fn(async (_content: string) => {});
    const r = await announceTick(db, post, { now: at("2026-09-13T20:00:00Z"), offHour: 8 });
    expect(r.posted).toBe(1);
  });

  // ⚠️ ...but a notice that lands after the wipe tells players a wipe is coming that
  // already took their car. Past the cutoff, record it and say nothing.
  it("records missed past the cutoff, without posting", async () => {
    const post = vi.fn(async (_content: string) => {});
    const r = await announceTick(db, post, { now: at("2026-09-14T07:30:00Z"), offHour: 8 });
    expect(r).toEqual({ posted: 0, missed: 1, failed: 0 });
    expect(post).not.toHaveBeenCalled();
    expect(await rows()).toMatchObject([{ outcome: "missed" }]);
  });

  it("does not re-announce the wipe currently in progress", async () => {
    const post = vi.fn(async (_content: string) => {});
    const r = await announceTick(db, post, { now: at("2026-09-14T09:00:00Z"), offHour: 8 });
    // 09:00 Monday: the coming wipe is NEXT Monday, whose announce moment is days away.
    expect(r).toEqual({ posted: 0, missed: 0, failed: 0 });
    expect(post).not.toHaveBeenCalled();
  });

  // ⚠️ Post-then-insert: a row written first would record an announcement that never
  // went out. No row means the next tick retries, which is the direction this repo picks.
  it("writes no row when the post fails, so the next tick retries", async () => {
    const bad = vi.fn(async (_content: string) => { throw new Error("discord down"); });
    const onError = vi.fn();
    const r = await announceTick(db, bad, { now: at("2026-09-13T08:00:01Z"), offHour: 8, onError });
    expect(r).toEqual({ posted: 0, missed: 0, failed: 1 });
    expect(await rows()).toEqual([]);
    expect(onError).toHaveBeenCalled();

    const good = vi.fn(async (_content: string) => {});
    const again = await announceTick(db, good, { now: at("2026-09-13T08:05:00Z"), offHour: 8 });
    expect(again.posted).toBe(1);
    expect(await rows()).toHaveLength(1);
  });

  // ⚠️ The spec asks for "two servers produce one message". `announceTick` takes no
  // server input at all and never queries `servers`, so a two-server test would assert
  // nothing. The guarantee lives in the schema instead — `wipe_at` is the whole primary
  // key — and this is the test that would fail if a `server_id` were ever added to it.
  it("keys the row on the wipe slot alone, so a second call for that week cannot insert", async () => {
    const post = vi.fn(async (_content: string) => {});
    await announceTick(db, post, { now: at("2026-09-13T08:00:01Z"), offHour: 8 });
    const all = await rows();
    expect(all).toHaveLength(1);
    expect(Object.keys(all[0]!)).not.toContain("serverId");
  });

  it("advances to the next week once this week's row exists", async () => {
    const post = vi.fn(async (_content: string) => {});
    await announceTick(db, post, { now: at("2026-09-13T08:00:01Z"), offHour: 8 });
    await announceTick(db, post, { now: at("2026-09-20T08:00:01Z"), offHour: 8 });
    expect(post).toHaveBeenCalledTimes(2);
    expect(post.mock.calls[1]![0]).toContain("Gunter");
    expect(await rows()).toHaveLength(2);
  });
});
