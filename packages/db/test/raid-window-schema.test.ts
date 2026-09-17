import { describe, it, expect, beforeEach } from "vitest";
import { createClient, runMigrations, requireTestDatabaseUrl, type Database } from "@factions/db";
import { sql } from "drizzle-orm";
import { raidWindowFlips, raidWindowSkips, raidWindowAnnouncements } from "../src/schema";

const URL = requireTestDatabaseUrl();

describe("raid window tables", () => {
  let db: Database;
  beforeEach(async () => {
    db = createClient(URL);
    await runMigrations(db);
    // ⚠️ Truncate what THIS suite writes, nothing else. Packages share
    // factions_test_<package> across their own suites.
    await db.execute(sql`truncate table raid_window_flips, raid_window_skips, raid_window_announcements`);
  });

  it("accepts a flip row and rejects a bad outcome", async () => {
    // ⚠️ id is GENERATED ALWAYS AS IDENTITY: an explicit value needs OVERRIDING SYSTEM VALUE,
    // and map/clock_offset_ms are NOT NULL with no default (see schema.ts's comment on both).
    await db.execute(sql`insert into servers (id, name, map, clock_offset_ms, active) overriding system value
                         values (900, 'raid-window-900', 'livonia', 0, true) on conflict do nothing`);
    await db.insert(raidWindowFlips).values({
      serverId: 900,
      boundaryAt: new Date("2026-09-18T00:00:00Z"),
      wantedDisabled: false,
      outcome: "applied",
      appliedAt: new Date(),
      previousContent: "{}",
    });
    await expect(
      db.execute(sql`insert into raid_window_flips (server_id, boundary_at, wanted_disabled, outcome)
                     values (900, '2026-09-25T00:00:00Z', false, 'nonsense')`),
    ).rejects.toThrow();
  });

  it("⚠️ one flip row per server per boundary", async () => {
    await db.execute(sql`insert into servers (id, name, map, clock_offset_ms, active) overriding system value
                         values (901, 'raid-window-901', 'livonia', 0, true) on conflict do nothing`);
    const row = {
      serverId: 901,
      boundaryAt: new Date("2026-09-18T00:00:00Z"),
      wantedDisabled: false,
      outcome: "applied" as const,
    };
    await db.insert(raidWindowFlips).values(row);
    await expect(db.insert(raidWindowFlips).values(row)).rejects.toThrow();
  });

  it("⚠️ one announcement per (boundary, kind) — this is what makes a failure alert fire once", async () => {
    const row = {
      boundaryAt: new Date("2026-09-18T00:00:00Z"),
      kind: "failure" as const,
      announcedAt: new Date(),
      outcome: "posted" as const,
    };
    await db.insert(raidWindowAnnouncements).values(row);
    await expect(db.insert(raidWindowAnnouncements).values(row)).rejects.toThrow();
    // A different kind at the same boundary is fine.
    await db.insert(raidWindowAnnouncements).values({ ...row, kind: "open" });
  });

  it("one skip per window", async () => {
    const row = { opensAt: new Date("2026-09-18T00:00:00Z"), reason: "launch", decidedAt: new Date() };
    await db.insert(raidWindowSkips).values(row);
    await expect(db.insert(raidWindowSkips).values(row)).rejects.toThrow();
  });
});
