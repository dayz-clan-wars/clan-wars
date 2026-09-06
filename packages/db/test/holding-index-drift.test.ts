import { describe, it, expect, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createClient, runMigrations, requireTestDatabaseUrl, type Database } from "@factions/db";
import { HOLDING_STATUSES } from "@factions/domain";
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

  it("the supplied predicate is 'active and flag_down_since is null', spelled in the worker's query", () => {
    const worker = readFileSync(join(import.meta.dirname, "..", "..", "..", "apps", "ingest-worker", "src", "supply-tick.ts"), "utf8");
    expect(worker).toMatch(/eq\(factions\.status, "active"\)/u);
    expect(worker).toMatch(/isNull\(factions\.flagDownSince\)/u);
    expect(worker).not.toMatch(/SUPPLIED_STATUSES/u);
  });
});
