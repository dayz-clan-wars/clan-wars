import { describe, it, expect, beforeEach } from "vitest";
import { createClient, runMigrations, requireTestDatabaseUrl, serverRestarts, type Database } from "@factions/db";
import { sql } from "drizzle-orm";
import { restartsScheduledDb, RESTART_EVIDENCE_MS } from "../src/restarts";

const URL = requireTestDatabaseUrl();

const NOW = new Date("2026-09-18T14:30:00.000Z");
const ago = (ms: number) => new Date(NOW.getTime() - ms);

/**
 * Whether the site may show a restart countdown at all. The countdown itself is
 * pure arithmetic on the epoch and always has an answer — which is exactly why
 * this read exists: `restart-tick` is gated on the bot's `RESTART_SCHEDULE`, the
 * web app cannot see that env, and a confident clock on a server nothing ever
 * restarts is the kind of lie this codebase has a ⚠️ about everywhere else.
 */
describe("restartsScheduledDb", () => {
  let db: Database;

  beforeEach(async () => {
    db = createClient(URL);
    await runMigrations(db);
    // ⚠️ Truncate what THIS suite writes, nothing else — factions_test_<package>
    // is shared across the package's own suites.
    await db.execute(sql`truncate table server_restarts`);
  });

  // ⚠️ id is GENERATED ALWAYS AS IDENTITY: an explicit value needs OVERRIDING SYSTEM VALUE,
  // and map/clock_offset_ms are NOT NULL with no default. Distinct names per row —
  // servers_name_map_uniq collides with rows other suites leave behind.
  const seedServer = (id: number, name: string) =>
    db.execute(sql`insert into servers (id, name, map, clock_offset_ms, active) overriding system value
                   values (${id}, ${name}, 'livonia', 0, true) on conflict do nothing`);

  const restart = (serverId: number, scheduledFor: Date, outcome: "restarted" | "skipped" | "missed" = "restarted") =>
    db.insert(serverRestarts).values({ serverId, scheduledFor, issuedAt: scheduledFor, outcome });

  it("⚠️ is false on an install that has never restarted anything", async () => {
    expect(await restartsScheduledDb(db, NOW)).toBe(false);
  });

  it("is true from a recent slot", async () => {
    await seedServer(930, "restarts-930");
    await restart(930, ago(2 * 60 * 60_000));
    expect(await restartsScheduledDb(db, NOW)).toBe(true);
  });

  /**
   * ⚠️ A `missed` row still proves the schedule is running — the tick woke up and
   * recorded that it had nothing to fire. Reading only `restarted` would hide the
   * countdown for a whole day over one Nitrado outage, which is the opposite of
   * what a player needs to know at that moment.
   */
  it("⚠️ counts a missed or skipped slot as evidence, not only a fired one", async () => {
    await seedServer(931, "restarts-931");
    await restart(931, ago(60 * 60_000), "missed");
    expect(await restartsScheduledDb(db, NOW)).toBe(true);
    await db.execute(sql`truncate table server_restarts`);
    await restart(931, ago(60 * 60_000), "skipped");
    expect(await restartsScheduledDb(db, NOW)).toBe(true);
  });

  it("goes false once the newest slot falls outside the evidence window", async () => {
    await seedServer(932, "restarts-932");
    await restart(932, ago(RESTART_EVIDENCE_MS + 60_000));
    expect(await restartsScheduledDb(db, NOW)).toBe(false);
  });

  it("holds right at the edge of the window", async () => {
    await seedServer(933, "restarts-933");
    await restart(933, ago(RESTART_EVIDENCE_MS));
    expect(await restartsScheduledDb(db, NOW)).toBe(true);
  });

  // A row dated ahead of now is a clock skew, not a restart that happened. It is
  // still evidence the tick is running, and excluding it would blank the bar for
  // a day over a few seconds of drift.
  it("accepts the slot the tick is currently inside", async () => {
    await seedServer(934, "restarts-934");
    await restart(934, new Date(NOW.getTime() + 60_000));
    expect(await restartsScheduledDb(db, NOW)).toBe(true);
  });
});
