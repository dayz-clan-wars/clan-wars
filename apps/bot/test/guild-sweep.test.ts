import { describe, it, expect, beforeEach } from "vitest";
import { createClient, runMigrations, requireTestDatabaseUrl, identityLinks, type Database } from "@factions/db";
import { sql } from "drizzle-orm";
import { sweepMissedRemovals } from "../src/guild-sweep.js";
import type { RemoveFromGuild } from "../src/guild-removal.js";

const URL = requireTestDatabaseUrl();
const now = new Date("2026-11-06T12:00:00Z");

describe("sweepMissedRemovals", () => {
  let db: Database;
  const seed = async (n: number) => {
    for (let i = 1; i <= n; i++) {
      await db.insert(identityLinks).values({ discordId: `d${i}`, dayzId: `z${i}`, gamertag: `G${i}`, verifiedAt: now });
    }
  };
  const fakeRemove = (calls: string[], failOn?: string): RemoveFromGuild => async (d, a) => {
    calls.push(a.discordId);
    if (a.discordId === failOn) throw new Error("boom");
    await d.execute(sql`delete from identity_links where discord_id = ${a.discordId}`);
    return { linked: true, roster: "none" } as never;
  };
  const left = async () => (await db.select().from(identityLinks)).map((l) => l.discordId);

  beforeEach(async () => {
    db = createClient(URL);
    await runMigrations(db);
    await db.execute(sql`truncate table identity_links restart identity cascade`);
  });

  it("never runs before a full fetch", async () => {
    await seed(2);
    const calls: string[] = [];
    const r = await sweepMissedRemovals(db, { ready: false, isMember: () => false, now, max: 5, remove: fakeRemove(calls) });
    expect(r).toEqual({ removed: [], capped: false });
    expect(calls).toEqual([]);
    expect(await left()).toHaveLength(2);
  });

  it("does nothing when every linked user is a member", async () => {
    await seed(3);
    const calls: string[] = [];
    const r = await sweepMissedRemovals(db, { ready: true, isMember: () => true, now, max: 5, remove: fakeRemove(calls) });
    expect(r).toEqual({ removed: [], capped: false });
    expect(calls).toEqual([]);
  });

  it("removes linked non-members through remove", async () => {
    await seed(3);
    const calls: string[] = [];
    const r = await sweepMissedRemovals(db, { ready: true, isMember: (id) => id === "d2", now, max: 5, remove: fakeRemove(calls) });
    expect(r).toEqual({ removed: ["d1", "d3"], capped: false });
    expect(await left()).toEqual(["d2"]);
  });

  it("stops at the cap, oldest first", async () => {
    await seed(8);
    const calls: string[] = [];
    const r = await sweepMissedRemovals(db, { ready: true, isMember: () => false, now, max: 5, remove: fakeRemove(calls) });
    expect(r.capped).toBe(true);
    expect(r.removed).toEqual(["d1", "d2", "d3", "d4", "d5"]);
    expect(await left()).toEqual(["d6", "d7", "d8"]);
  });

  it("one remove throwing does not stop the rest", async () => {
    await seed(3);
    const calls: string[] = [];
    const r = await sweepMissedRemovals(db, { ready: true, isMember: () => false, now, max: 5, remove: fakeRemove(calls, "d1") });
    expect(r.removed).toEqual(["d2", "d3"]);
    expect(calls).toEqual(["d1", "d2", "d3"]);
  });
});
