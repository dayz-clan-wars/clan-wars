import { describe, it, expect, beforeEach } from "vitest";
import { sql } from "drizzle-orm";
import {
  createClient, runMigrations, requireTestDatabaseUrl, referrals,
  clearReferrals, assertTestDatabaseName, type Database,
} from "../src/index.js";

const URL = requireTestDatabaseUrl();

describe("assertTestDatabaseName", () => {
  // Unit-tested directly rather than by connecting to a non-prefixed
  // database from this suite: doing that on purpose is exactly the mistake
  // the guard exists to prevent, and the harness only ever hands us a
  // `factions_test_*` database anyway.
  it("accepts a name starting with the test database prefix", () => {
    expect(() => assertTestDatabaseName("factions_test_db")).not.toThrow();
    expect(() => assertTestDatabaseName("factions_test_roster")).not.toThrow();
  });

  it("refuses a name that does not start with the prefix", () => {
    expect(() => assertTestDatabaseName("factions_live")).toThrow(/refuses/iu);
    expect(() => assertTestDatabaseName("factions")).toThrow(/refuses/iu);
    expect(() => assertTestDatabaseName("")).toThrow(/refuses/iu);
  });
});

describe("clearReferrals", () => {
  let db: Database;
  beforeEach(async () => {
    db = createClient(URL);
    await runMigrations(db);
    // ⚠️ Qualifications first: they FK-reference `referrals`, so a leftover
    // qualification row (this file's own prior test, or another suite sharing
    // this per-package database) would otherwise block deleting `referrals`.
    await db.execute(sql`ALTER TABLE referral_qualifications DISABLE TRIGGER USER`);
    await db.execute(sql`DELETE FROM referral_qualifications`);
    await db.execute(sql`ALTER TABLE referral_qualifications ENABLE TRIGGER USER`);
    await db.execute(sql`ALTER TABLE referrals DISABLE TRIGGER USER`);
    await db.execute(sql`DELETE FROM referrals`);
    await db.execute(sql`ALTER TABLE referrals ENABLE TRIGGER USER`);
  });

  it("still empties referrals on the test database", async () => {
    await db.insert(referrals).values({
      referredDiscordId: "A",
      referrerDiscordId: "B",
      referrerDayzId: "uid-B",
      source: "later_bot",
    });

    await clearReferrals(db);

    const rows = await db.select().from(referrals);
    expect(rows).toHaveLength(0);
  });
});
