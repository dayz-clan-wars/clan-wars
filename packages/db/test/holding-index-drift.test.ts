import { describe, it, expect, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createClient, runMigrations, requireTestDatabaseUrl, type Database } from "@factions/db";
import { HOLDING_STATUSES, SUPPLIED_PREDICATE, isSupplied } from "@factions/domain";
import { sql } from "drizzle-orm";

const URL = requireTestDatabaseUrl();

/**
 * ⚠️ HOLDING_STATUSES exists twice: once in TypeScript, once as a SQL literal
 * in each of two partial unique index predicates, plus the `declarations`
 * uniques. They are two statements of one fact and nothing but this test
 * holds them together. Drift means a faction keeps or loses its flag, tag or
 * pole in a state nobody intended.
 */
describe("faction scarcity indexes match HOLDING_STATUSES", () => {
  let db: Database;
  beforeEach(async () => {
    db = createClient(URL);
    await runMigrations(db);
  });

  const INDEXES = [
    "factions_holding_texture_uniq",
    "factions_holding_tag_uniq",
  ];

  it("enumerates exactly the holding statuses in every predicate", async () => {
    const rows = await db.execute(sql`
      select indexname, indexdef from pg_indexes
      where schemaname = 'public' and indexname = any(${sql.raw(`ARRAY['${INDEXES.join("','")}']`)})
    `);
    const found = rows as unknown as { indexname: string; indexdef: string }[];
    expect(found.map((r) => r.indexname).sort()).toEqual([...INDEXES].sort());

    for (const row of found) {
      const statuses = [...row.indexdef.matchAll(/'([a-z]+)'::text/g)].map((m) => m[1]);
      expect(new Set(statuses)).toEqual(new Set(HOLDING_STATUSES));
    }
  });

  it("the pole half of HOLDING is the existence of a declarations row", async () => {
    // ⚠️ factions_holding_pole_uniq is gone on purpose (increment 1). A
    // holding faction's pole is now declarations.owner_faction_id, unique on
    // its own. This test only checks the three index names exist; the check
    // that a pole column has NOT reappeared on factions lives in
    // declarations.test.ts ("factions no longer carries pole columns").
    const rows = await db.execute(sql`
      select indexname from pg_indexes where schemaname = 'public'
        and indexname in ('declarations_pole_uniq','declarations_faction_uniq','declarations_player_uniq')
    `);
    expect(rows.length).toBe(3);
  });

  it("the worker decides supplied through the domain helper, not a re-spelled predicate", () => {
    const worker = readFileSync(join(import.meta.dirname, "..", "..", "..", "apps", "ingest-worker", "src", "supply-tick.ts"), "utf8");
    // ⚠️ The query is now the HOLDING set — dormant and flag-down clans are
    // IN the file, for their flags alone (supplies.ts's SupplyFaction says
    // why). What separates a crate from a bare flag is `isSupplied`, and it
    // lives in @factions/domain so the predicate has exactly one statement.
    expect(worker).toMatch(/inArray\(factions\.status, \[\.\.\.HOLDING_STATUSES\]\)/u);
    expect(worker).toMatch(/isSupplied\(/u);
    // A worker that spells the predicate inline again compiles, passes its
    // own tests, and drifts the moment the domain's version changes.
    expect(worker).not.toMatch(/isNull\(factions\.flagDownSince\)/u);
    expect(worker).not.toMatch(/inArray\(factions\.status, \["reserved", "active"\]\)/u);
    expect(worker).not.toMatch(/eq\(factions\.status, "active"\)/u);
  });

  it("isSupplied is SUPPLIED_PREDICATE: reserved or active, and no flag down", () => {
    // ⚠️ The SQL string in SUPPLIED_PREDICATE and this function are two
    // statements of one fact. Nothing but this test holds them together, and
    // drift means a clan silently keeps or loses its crate.
    expect(SUPPLIED_PREDICATE).toBe("status in ('reserved', 'active') and flag_down_since is null");
    expect(isSupplied("reserved", null)).toBe(true);
    expect(isSupplied("active", null)).toBe(true);
    expect(isSupplied("active", new Date())).toBe(false);
    expect(isSupplied("dormant", null)).toBe(false);
  });
});
