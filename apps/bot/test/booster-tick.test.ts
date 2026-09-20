import { describe, it, expect, beforeEach } from "vitest";
import { createClient, runMigrations, requireTestDatabaseUrl, discordBoosters,
         boosterKits, clanNotices, servers, type Database } from "@factions/db";
import { eq, sql } from "drizzle-orm";
import { boosterTick, type BoosterSource } from "../src/booster-tick.js";

const URL = requireTestDatabaseUrl();
const at = (iso: string) => new Date(iso);
const now = at("2026-09-19T00:00:00Z");
let serverId: number;

/** A source that answers with exactly what a test hands it. */
const source = (list: { discordId: string; premiumSince: Date }[]): BoosterSource => ({
  fetchBoosters: async () => list,
});

const failingSource: BoosterSource = {
  fetchBoosters: async () => {
    throw new Error("gateway down");
  },
};

describe("boosterTick", () => {
  let db: Database;

  beforeEach(async () => {
    db = createClient(URL);
    await runMigrations(db);
    // ⚠️ clan_notices.server_id is NOT NULL and references servers.id, so the
    // prompt assertions need a real server row. Without one every one of them
    // fails on a foreign key violation, which reads as broken behaviour rather
    // than broken setup. Same seeding shape as apps/bot/test/ban-announce-tick.test.ts.
    await db.execute(sql`truncate table servers, discord_boosters, booster_kits, clan_notices restart identity cascade`);
    const [s] = await db.insert(servers).values({ name: "S", map: "livonia", clockOffsetMs: 0 }).returning();
    serverId = s!.id;
  });

  it("inserts a row per current booster", async () => {
    const since = at("2026-09-18T00:00:00Z");
    const r = await boosterTick(db, { source: source([{ discordId: "1", premiumSince: since }]), now: at("2026-09-19T00:00:00Z"), serverId, kitUrl: "https://example.test/kit" });
    expect(r).toMatchObject({ boosters: 1, added: 1, removed: 0 });
    const rows = await db.select().from(discordBoosters);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ discordId: "1", premiumSince: since });
  });

  it("deletes rows for anyone no longer boosting", async () => {
    const since = at("2026-09-18T00:00:00Z");
    await boosterTick(db, { source: source([{ discordId: "1", premiumSince: since }]), now: at("2026-09-19T00:00:00Z"), serverId, kitUrl: "https://example.test/kit" });
    const r = await boosterTick(db, { source: source([]), now: at("2026-09-19T00:05:00Z"), serverId, kitUrl: "https://example.test/kit" });
    expect(r).toMatchObject({ boosters: 0, added: 0, removed: 1 });
    expect(await db.select().from(discordBoosters)).toEqual([]);
  });

  it("is idempotent when nothing changed", async () => {
    const since = at("2026-09-18T00:00:00Z");
    const list = [{ discordId: "1", premiumSince: since }];
    await boosterTick(db, { source: source(list), now: at("2026-09-19T00:00:00Z"), serverId, kitUrl: "https://example.test/kit" });
    const r = await boosterTick(db, { source: source(list), now: at("2026-09-19T00:05:00Z"), serverId, kitUrl: "https://example.test/kit" });
    expect(r).toMatchObject({ boosters: 1, added: 0, removed: 0 });
  });

  // ⚠️ The important one: a Discord outage that resolved to an empty list
  // must not be mistaken for "nobody is boosting" — that would revoke every
  // kit on the server at the next restart. Nothing may be deleted when the
  // fetch throws, and the throw must propagate so the caller knows the tick
  // did not run.
  it("does not delete anyone when the fetch throws", async () => {
    const since = at("2026-09-18T00:00:00Z");
    await boosterTick(db, { source: source([{ discordId: "1", premiumSince: since }]), now: at("2026-09-19T00:00:00Z"), serverId, kitUrl: "https://example.test/kit" });
    await expect(boosterTick(db, { source: failingSource, now: at("2026-09-19T00:05:00Z"), serverId, kitUrl: "https://example.test/kit" })).rejects.toThrow("gateway down");
    expect(await db.select().from(discordBoosters)).toHaveLength(1);
  });

  it("prompts a booster who has never chosen a kit", async () => {
    const res = await boosterTick(db, { source: source([{ discordId: "a", premiumSince: new Date() }]), now, serverId, kitUrl: "https://example.test/kit" });
    expect(res.prompted).toBe(1);
    const [n] = await db.select().from(clanNotices).where(eq(clanNotices.kind, "booster_kit_unchosen"));
    expect(n!.discordTargetId).toBe("a");
    expect(n!.target).toBe("dm");
  });

  it("does not prompt a booster who already has a kit", async () => {
    await db.insert(boosterKits).values({ discordId: "a" });
    const res = await boosterTick(db, { source: source([{ discordId: "a", premiumSince: new Date() }]), now, serverId, kitUrl: "https://example.test/kit" });
    expect(res.prompted).toBe(0);
  });

  // ⚠️ The failure this guards: the condition stays true until they choose, and
  // the tick is level-triggered, so without the column every run re-DMs them.
  it("does not prompt the same booster twice across two runs", async () => {
    const src = source([{ discordId: "a", premiumSince: new Date() }]);
    await boosterTick(db, { source: src, now, serverId, kitUrl: "https://example.test/kit" });
    const second = await boosterTick(db, { source: src, now, serverId, kitUrl: "https://example.test/kit" });
    expect(second.prompted).toBe(0);
    const rows = await db.select().from(clanNotices).where(eq(clanNotices.kind, "booster_kit_unchosen"));
    expect(rows).toHaveLength(1);
  });

  it("prompts again after someone stops boosting and starts again", async () => {
    await boosterTick(db, { source: source([{ discordId: "a", premiumSince: new Date() }]), now, serverId, kitUrl: "https://example.test/kit" });
    await boosterTick(db, { source: source([]), now, serverId, kitUrl: "https://example.test/kit" });
    const back = await boosterTick(db, { source: source([{ discordId: "a", premiumSince: new Date() }]), now, serverId, kitUrl: "https://example.test/kit" });
    expect(back.prompted).toBe(1);
  });

  // ⚠️ The tick's existing warning about a Discord outage resolving to an empty
  // member list applies here one step worse: a prompt cannot be unsent.
  it("emits nothing when the booster fetch throws", async () => {
    await expect(boosterTick(db, { source: failingSource, now, serverId, kitUrl: "https://example.test/kit" })).rejects.toThrow(/gateway down/u);
    const rows = await db.select().from(clanNotices).where(eq(clanNotices.kind, "booster_kit_unchosen"));
    expect(rows).toEqual([]);
  });
});
