import { describe, it, expect, beforeEach, vi } from "vitest";
import { createClient, runMigrations, requireTestDatabaseUrl, raidWindowFlips, raidWindowAnnouncements, type Database } from "@factions/db";
import { sql } from "drizzle-orm";
import { raidWindowTick } from "../src/raid-window-tick.js";

const URL = requireTestDatabaseUrl();
const FRI = new Date("2026-09-18T00:00:00.000Z");

// ⚠️ id is GENERATED ALWAYS AS IDENTITY: an explicit value needs OVERRIDING SYSTEM
// VALUE, and map/clock_offset_ms are NOT NULL with no default. Names must be distinct
// across the whole suite run — servers_name_map_uniq collides with rows other suites
// leave behind, and ON CONFLICT DO NOTHING then swallows the collision silently.
async function seedServer(db: Database, id: number) {
  await db.execute(sql`insert into servers (id, name, map, clock_offset_ms, active) overriding system value
                       values (${id}, ${`raid-window-tick-${id}`}, 'livonia', 0, true) on conflict do nothing`);
}

describe("raidWindowTick", () => {
  let db: Database;
  beforeEach(async () => {
    db = createClient(URL);
    await runMigrations(db);
    // ⚠️ Truncate what THIS suite writes, nothing else. Packages share
    // factions_test_<package> across their own suites.
    await db.execute(sql`truncate table raid_window_flips, raid_window_skips, raid_window_announcements`);
  });

  it("⚠️ does NOT post 'open' while no flip is confirmed", async () => {
    const post = vi.fn(async (_content: string) => undefined);
    const r = await raidWindowTick(db, { announce: post, ops: post }, { now: FRI });
    expect(post).not.toHaveBeenCalled();
    expect(r.posted).toBe(0);
  });

  it("posts 'open' once the flip is confirmed, and only once", async () => {
    await seedServer(db, 910);
    await db.insert(raidWindowFlips).values({
      serverId: 910, boundaryAt: FRI, wantedDisabled: false,
      outcome: "applied", appliedAt: FRI, restartConfirmedAt: FRI,
    });
    const post = vi.fn(async (_content: string) => undefined);
    const first = await raidWindowTick(db, { announce: post, ops: post }, { now: FRI });
    expect(first.posted).toBe(1);
    expect(post.mock.calls[0]![0]).toMatch(/Raid weekend is live/);

    const second = await raidWindowTick(db, { announce: post, ops: post }, { now: FRI });
    expect(second.posted).toBe(0);
    expect(post).toHaveBeenCalledTimes(1);
  });

  it("⚠️ an upload with no confirmed restart is not confirmation", async () => {
    await seedServer(db, 911);
    await db.insert(raidWindowFlips).values({
      serverId: 911, boundaryAt: FRI, wantedDisabled: false,
      outcome: "applied", appliedAt: FRI, restartConfirmedAt: null,
    });
    const post = vi.fn(async (_content: string) => undefined);
    const r = await raidWindowTick(db, { announce: post, ops: post }, { now: FRI });
    expect(r.posted).toBe(0);
  });

  it("⚠️ writes no row when the post throws, so the next tick retries", async () => {
    await seedServer(db, 912);
    await db.insert(raidWindowFlips).values({
      serverId: 912, boundaryAt: FRI, wantedDisabled: false,
      outcome: "applied", appliedAt: FRI, restartConfirmedAt: FRI,
    });
    const post = vi.fn(async (_content: string) => { throw new Error("discord down"); });
    await raidWindowTick(db, { announce: post, ops: post }, { now: FRI });
    const rows = await db.select().from(raidWindowAnnouncements);
    expect(rows.filter((r) => r.kind === "open")).toEqual([]);
  });

  it("posts the Thursday advance notice once", async () => {
    const post = vi.fn(async (_content: string) => undefined);
    const thu = new Date("2026-09-17T12:00:00.000Z");
    const r = await raidWindowTick(db, { announce: post, ops: post }, { now: thu });
    expect(r.posted).toBe(1);
    expect(post.mock.calls[0]![0]).toMatch(/opens tomorrow/);
  });

  it("⚠️ alerts ops once per boundary on a refused flip, not once per slot", async () => {
    await seedServer(db, 913);
    await db.insert(raidWindowFlips).values({
      serverId: 913, boundaryAt: FRI, wantedDisabled: false,
      outcome: "refused", detail: { error: 'no "disableBaseDamage" key found' },
    });
    const announce = vi.fn(async (_content: string) => undefined);
    const ops = vi.fn(async (_content: string) => undefined);

    await raidWindowTick(db, { announce, ops }, { now: FRI });
    expect(ops).toHaveBeenCalledTimes(1);
    expect(ops.mock.calls[0]![0]).toMatch(/Raid window flip failed/);
    expect(ops.mock.calls[0]![0]).toMatch(/still ON/);

    // Two hours later the tick runs again. The flip retries; the alert must not.
    await raidWindowTick(db, { announce, ops }, { now: new Date(FRI.getTime() + 2 * 60 * 60 * 1000) });
    expect(ops).toHaveBeenCalledTimes(1);
  });

  it("⚠️ a refused flip never produces an 'open' message", async () => {
    await seedServer(db, 914);
    await db.insert(raidWindowFlips).values({
      serverId: 914, boundaryAt: FRI, wantedDisabled: false,
      outcome: "refused", detail: { error: "boom" },
    });
    const announce = vi.fn(async (_content: string) => undefined);
    const ops = vi.fn(async (_content: string) => undefined);
    await raidWindowTick(db, { announce, ops }, { now: FRI });
    expect(announce).not.toHaveBeenCalled();
  });
});
