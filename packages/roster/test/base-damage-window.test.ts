import { describe, it, expect, beforeEach } from "vitest";
import { createClient, runMigrations, requireTestDatabaseUrl, raidWindowFlips, raidWindowSkips, type Database } from "@factions/db";
import { sql } from "drizzle-orm";
import { baseDamageWindowDb } from "../src/base-damage-window";

const URL = requireTestDatabaseUrl();

const FRI = new Date("2026-09-18T00:00:00.000Z");

/**
 * The site's status-strip read: is base damage actually on right now, per a
 * CONFIRMED flip — never per the clock alone.
 */
describe("baseDamageWindowDb", () => {
  let db: Database;

  beforeEach(async () => {
    db = createClient(URL);
    await runMigrations(db);
    // ⚠️ Truncate what THIS suite writes, nothing else — factions_test_<package>
    // is shared across the package's own suites.
    await db.execute(sql`truncate table raid_window_flips, raid_window_skips`);
  });

  // ⚠️ id is GENERATED ALWAYS AS IDENTITY: an explicit value needs OVERRIDING SYSTEM VALUE,
  // and map/clock_offset_ms are NOT NULL with no default (servers.ts's comment on both).
  // Distinct names per row — servers_name_map_uniq collides with rows other suites leave behind.
  const seedServer = (id: number, name: string) =>
    db.execute(sql`insert into servers (id, name, map, clock_offset_ms, active) overriding system value
                   values (${id}, ${name}, 'livonia', 0, true) on conflict do nothing`);

  it("⚠️ says unconfirmed — never 'live' — when the window is open but no flip is confirmed", async () => {
    const w = await baseDamageWindowDb(db, FRI);
    expect(w.status).toBe("unconfirmed");
  });

  it("says live once a flip is confirmed", async () => {
    await seedServer(920, "bdw-920");
    await db.insert(raidWindowFlips).values({
      serverId: 920, boundaryAt: FRI, wantedDisabled: false,
      outcome: "applied", appliedAt: FRI, restartConfirmedAt: FRI,
    });
    const w = await baseDamageWindowDb(db, FRI);
    expect(w.status).toBe("live");
    expect(w.closesAt.toISOString()).toBe("2026-09-21T00:00:00.000Z");
  });

  it("⚠️ a confirmed flip from LAST weekend does not confirm this one", async () => {
    await seedServer(921, "bdw-921");
    await db.insert(raidWindowFlips).values({
      serverId: 921, boundaryAt: new Date("2026-09-11T00:00:00.000Z"), wantedDisabled: false,
      outcome: "applied", appliedAt: FRI, restartConfirmedAt: FRI,
    });
    const w = await baseDamageWindowDb(db, FRI);
    expect(w.status).toBe("unconfirmed");
  });

  it("says skipped with the reason", async () => {
    await db.insert(raidWindowSkips).values({ opensAt: FRI, reason: "launch weekend", decidedAt: FRI });
    const w = await baseDamageWindowDb(db, FRI);
    expect(w.status).toBe("skipped");
    expect(w.skipReason).toBe("launch weekend");
  });

  it("says closed midweek when the close is confirmed", async () => {
    const wed = new Date("2026-09-16T00:00:00.000Z");
    await seedServer(922, "bdw-922");
    await db.insert(raidWindowFlips).values({
      serverId: 922, boundaryAt: new Date("2026-09-14T00:00:00.000Z"), wantedDisabled: true,
      outcome: "applied", appliedAt: wed, restartConfirmedAt: wed,
    });
    const w = await baseDamageWindowDb(db, wed);
    expect(w.status).toBe("closed");
  });

  // ⚠️ The direction the strip has to name. An unconfirmed CLOSE leaves base damage
  // ON, so the site must not call it an opening; deriving that at the render site
  // from the two instants is the drift this feature avoids everywhere else.
  it("says which flip is missing when unconfirmed", async () => {
    expect((await baseDamageWindowDb(db, FRI)).pending).toBe("open");
    const wed = new Date("2026-09-16T00:00:00.000Z");
    expect((await baseDamageWindowDb(db, wed)).pending).toBe("close");
  });

  /**
   * ⚠️ `boundaryAt` is carried out, not left behind. The timer bar fills its
   * progress rule from the LAST boundary passed to the next one, and midweek that
   * is the previous close — `closesAt` minus a week. Re-deriving it at the render
   * site is the same mistake the flip lookup has a ⚠️ about two lines up in the
   * source: three independent derivations of this instant disagreed once already.
   */
  it("⚠️ carries the boundary already passed, for the bar's progress fill", async () => {
    // In the window: the boundary is this window's open.
    expect((await baseDamageWindowDb(db, FRI)).boundaryAt.toISOString()).toBe("2026-09-18T00:00:00.000Z");

    // Midweek: the PREVIOUS close, never the open ahead.
    const wed = new Date("2026-09-16T00:00:00.000Z");
    const w = await baseDamageWindowDb(db, wed);
    expect(w.boundaryAt.toISOString()).toBe("2026-09-14T00:00:00.000Z");
    expect(w.boundaryAt.getTime()).toBeLessThan(wed.getTime());
    expect(w.boundaryAt.getTime()).toBeLessThan(w.opensAt.getTime());
  });

  it("carries the boundary on a skipped weekend too", async () => {
    await db.insert(raidWindowSkips).values({ opensAt: FRI, reason: "launch weekend", decidedAt: FRI });
    expect((await baseDamageWindowDb(db, FRI)).boundaryAt.toISOString()).toBe("2026-09-18T00:00:00.000Z");
  });
});
