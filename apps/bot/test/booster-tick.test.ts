import { describe, it, expect, beforeEach } from "vitest";
import { createClient, runMigrations, requireTestDatabaseUrl, discordBoosters, type Database } from "@factions/db";
import { sql } from "drizzle-orm";
import { boosterTick, type BoosterSource } from "../src/booster-tick.js";

const URL = requireTestDatabaseUrl();
const at = (iso: string) => new Date(iso);

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
    await db.execute(sql`truncate table discord_boosters restart identity cascade`);
  });

  it("inserts a row per current booster", async () => {
    const since = at("2026-09-18T00:00:00Z");
    const r = await boosterTick(db, { source: source([{ discordId: "1", premiumSince: since }]), now: at("2026-09-19T00:00:00Z") });
    expect(r).toEqual({ boosters: 1, added: 1, removed: 0 });
    const rows = await db.select().from(discordBoosters);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ discordId: "1", premiumSince: since });
  });

  it("deletes rows for anyone no longer boosting", async () => {
    const since = at("2026-09-18T00:00:00Z");
    await boosterTick(db, { source: source([{ discordId: "1", premiumSince: since }]), now: at("2026-09-19T00:00:00Z") });
    const r = await boosterTick(db, { source: source([]), now: at("2026-09-19T00:05:00Z") });
    expect(r).toEqual({ boosters: 0, added: 0, removed: 1 });
    expect(await db.select().from(discordBoosters)).toEqual([]);
  });

  it("is idempotent when nothing changed", async () => {
    const since = at("2026-09-18T00:00:00Z");
    const list = [{ discordId: "1", premiumSince: since }];
    await boosterTick(db, { source: source(list), now: at("2026-09-19T00:00:00Z") });
    const r = await boosterTick(db, { source: source(list), now: at("2026-09-19T00:05:00Z") });
    expect(r).toEqual({ boosters: 1, added: 0, removed: 0 });
  });

  // ⚠️ The important one: a Discord outage that resolved to an empty list
  // must not be mistaken for "nobody is boosting" — that would revoke every
  // kit on the server at the next restart. Nothing may be deleted when the
  // fetch throws, and the throw must propagate so the caller knows the tick
  // did not run.
  it("does not delete anyone when the fetch throws", async () => {
    const since = at("2026-09-18T00:00:00Z");
    await boosterTick(db, { source: source([{ discordId: "1", premiumSince: since }]), now: at("2026-09-19T00:00:00Z") });
    await expect(boosterTick(db, { source: failingSource, now: at("2026-09-19T00:05:00Z") })).rejects.toThrow("gateway down");
    expect(await db.select().from(discordBoosters)).toHaveLength(1);
  });
});
