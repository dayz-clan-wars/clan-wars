import { describe, it, expect, beforeEach } from "vitest";
import { createClient, runMigrations, requireTestDatabaseUrl, identityLinks, type Database } from "@factions/db";
import { sql } from "drizzle-orm";
import { sweepMissedRemovals } from "../src/guild-sweep.js";
import type { RemoveFromGuild } from "../src/guild-removal.js";
import { FakeGuild } from "./fake-guild.js";

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
  // The REST confirmation agrees with the cache: Unknown Member.
  const gone = async () => false;
  const left = async () => (await db.select().from(identityLinks)).map((l) => l.discordId);

  beforeEach(async () => {
    db = createClient(URL);
    await runMigrations(db);
    await db.execute(sql`truncate table identity_links restart identity cascade`);
  });

  it("never runs before a full fetch", async () => {
    await seed(2);
    const calls: string[] = [];
    const r = await sweepMissedRemovals(db, { ready: false, isMember: () => false, memberExists: gone, now, max: 5, remove: fakeRemove(calls) });
    expect(r).toEqual({ removed: [], capped: false, missing: 0 });
    expect(calls).toEqual([]);
    expect(await left()).toHaveLength(2);
  });

  it("does nothing when every linked user is a member", async () => {
    await seed(3);
    const calls: string[] = [];
    const r = await sweepMissedRemovals(db, { ready: true, isMember: () => true, memberExists: gone, now, max: 5, remove: fakeRemove(calls) });
    expect(r).toEqual({ removed: [], capped: false, missing: 0 });
    expect(calls).toEqual([]);
  });

  it("removes linked non-members through remove", async () => {
    await seed(3);
    const calls: string[] = [];
    const r = await sweepMissedRemovals(db, { ready: true, isMember: (id) => id === "d2", memberExists: gone, now, max: 5, remove: fakeRemove(calls) });
    expect(r.removed.map((x) => x.discordId)).toEqual(["d1", "d3"]);
    expect(r.removed[0]).toEqual({ discordId: "d1", gamertag: "G1" });
    expect(r.capped).toBe(false);
    expect(await left()).toEqual(["d2"]);
  });

  it("halts over the cap: removes nobody", async () => {
    await seed(8);
    const calls: string[] = [];
    const r = await sweepMissedRemovals(db, { ready: true, isMember: () => false, memberExists: gone, now, max: 5, remove: fakeRemove(calls) });
    expect(r).toEqual({ removed: [], capped: true, missing: 8 });
    expect(calls).toEqual([]);
    expect(await left()).toHaveLength(8);
  });

  it("removes everyone when exactly at the cap", async () => {
    await seed(5);
    const calls: string[] = [];
    const r = await sweepMissedRemovals(db, { ready: true, isMember: () => false, memberExists: gone, now, max: 5, remove: fakeRemove(calls) });
    expect(r.capped).toBe(false);
    expect(r.removed.map((x) => x.discordId)).toEqual(["d1", "d2", "d3", "d4", "d5"]);
    expect(await left()).toEqual([]);
  });

  it("does not report a user whose link was already gone", async () => {
    await seed(2);
    const remove: RemoveFromGuild = async (_d, a) => ({ linked: a.discordId !== "d1", roster: "none" }) as never;
    const r = await sweepMissedRemovals(db, { ready: true, isMember: () => false, memberExists: gone, now, max: 5, remove });
    expect(r.removed.map((x) => x.discordId)).toEqual(["d2"]);
  });

  it("uses the real store by default", async () => {
    await seed(2);
    const r = await sweepMissedRemovals(db, { ready: true, isMember: (id) => id === "d2", memberExists: gone, now, max: 5 });
    expect(r.removed.map((x) => x.discordId)).toEqual(["d1"]);
    expect(await left()).toEqual(["d2"]);
  });

  it("one remove throwing does not stop the rest", async () => {
    await seed(3);
    const calls: string[] = [];
    const r = await sweepMissedRemovals(db, { ready: true, isMember: () => false, memberExists: gone, now, max: 5, remove: fakeRemove(calls, "d1") });
    expect(r.removed.map((x) => x.discordId)).toEqual(["d2", "d3"]);
    expect(calls).toEqual(["d1", "d2", "d3"]);
  });
  describe("confirms each candidate with a REST member fetch", () => {
    it("exists → kept, unknown → removed, error → skipped this pass", async () => {
      await seed(3);
      const guild = new FakeGuild();
      guild.restOnlyMembers.add("d1");   // missing from the cache, but still here
      guild.memberFetchFails.add("d3");  // Discord could not be asked
      const calls: string[] = [];
      const r = await sweepMissedRemovals(db, {
        ready: true, isMember: (id) => guild.isMember(id), memberExists: (id) => guild.fetchMemberExists(id),
        now, max: 5, remove: fakeRemove(calls),
      });
      expect(guild.calls).toEqual(["fetchMemberExists d1", "fetchMemberExists d2", "fetchMemberExists d3"]);
      expect(calls).toEqual(["d2"]);
      expect(r.removed.map((x) => x.discordId)).toEqual(["d2"]);
      expect(await left()).toEqual(["d1", "d3"]);
    });

    it("a throwing confirmation skips that user, like null", async () => {
      await seed(2);
      const calls: string[] = [];
      const r = await sweepMissedRemovals(db, {
        ready: true, isMember: () => false, now, max: 5, remove: fakeRemove(calls),
        memberExists: async (id) => { if (id === "d1") throw new Error("rest down"); return false; },
      });
      expect(r.removed.map((x) => x.discordId)).toEqual(["d2"]);
      expect(calls).toEqual(["d2"]);
    });

    it("⚠️ the over-the-cap halt counts cache misses and asks Discord about nobody", async () => {
      await seed(8);
      const guild = new FakeGuild();
      const r = await sweepMissedRemovals(db, {
        ready: true, isMember: (id) => guild.isMember(id), memberExists: (id) => guild.fetchMemberExists(id), now, max: 5,
      });
      expect(r).toEqual({ removed: [], capped: true, missing: 8 });
      expect(guild.calls).toEqual([]);
    });
  });
});
