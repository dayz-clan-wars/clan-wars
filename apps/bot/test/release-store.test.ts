import { describe, it, expect, beforeEach } from "vitest";
import { createClient, runMigrations, requireTestDatabaseUrl, releaseAnnouncements, type Database } from "@factions/db";
import { sql } from "drizzle-orm";
import { pgReleaseStore } from "../src/release-tick.js";

const URL = requireTestDatabaseUrl();

/**
 * The store's SQL, against a real database.
 *
 * ⚠️ `releaseTick`'s own tests run against an in-memory fake, so nothing else
 * in this suite ever executes these queries. `asc` and `desc` typecheck
 * identically, and a `desc` here would post the whole backfilled release
 * history newest-first into a live channel — messages that cannot be unposted.
 */
describe("pgReleaseStore", () => {
  let db: Database;
  beforeEach(async () => {
    db = createClient(URL);
    await runMigrations(db);
    await db.execute(sql`truncate table release_announcements`);
  });

  const queue = async (versions: string[]) => {
    for (const version of versions) {
      await db.insert(releaseAnnouncements).values({
        version,
        releasedAt: new Date("2026-09-07T00:00:00Z"),
        title: `release ${version}`,
        body: `### Added\n\n- Thing in ${version}.`,
      });
    }
  };

  it("returns the oldest unposted release, in insert order", async () => {
    await queue(["1.0.0", "1.1.0", "1.2.0"]);

    expect((await pgReleaseStore(db).readOldestUnposted())?.version).toBe("1.0.0");
  });

  it("returns the next one once the oldest is marked posted", async () => {
    await queue(["1.0.0", "1.1.0", "1.2.0"]);
    const store = pgReleaseStore(db);
    const first = await store.readOldestUnposted();

    await store.markPosted(first!.id, new Date("2026-09-17T12:00:00Z"));

    expect((await store.readOldestUnposted())?.version).toBe("1.1.0");
  });

  it("marks exactly one row, and records when", async () => {
    await queue(["1.0.0", "1.1.0"]);
    const store = pgReleaseStore(db);
    const first = await store.readOldestUnposted();
    const at = new Date("2026-09-17T12:00:00Z");

    await store.markPosted(first!.id, at);

    const rows = await db.select().from(releaseAnnouncements).orderBy(releaseAnnouncements.id);
    expect(rows.map((r) => r.postedAt)).toEqual([at, null]);
  });

  it("returns null when every release has been posted", async () => {
    await queue(["1.0.0"]);
    const store = pgReleaseStore(db);
    const only = await store.readOldestUnposted();
    await store.markPosted(only!.id, new Date("2026-09-17T12:00:00Z"));

    expect(await pgReleaseStore(db).readOldestUnposted()).toBeNull();
  });

  it("returns null when the queue is empty", async () => {
    expect(await pgReleaseStore(db).readOldestUnposted()).toBeNull();
  });

  it("round-trips a null title", async () => {
    // ⚠️ `title` is nullable on purpose — v1.16.0 and v1.17.0 were tagged with
    // no subject line. The renderer branches on `title === null`, so a store
    // that returned undefined or "" would title those posts wrongly.
    await db.insert(releaseAnnouncements).values({
      version: "1.17.0",
      releasedAt: new Date("2026-09-17T00:00:00Z"),
      title: null,
      body: "### Added\n\n- Untitled.",
    });

    expect((await pgReleaseStore(db).readOldestUnposted())?.title).toBeNull();
  });
});
