import { describe, it, expect, beforeEach } from "vitest";
import { createClient, runMigrations, requireTestDatabaseUrl, type Database } from "@factions/db";
import { HOLDING_STATUSES } from "@factions/domain";
import { sql } from "drizzle-orm";

const URL = requireTestDatabaseUrl();

/**
 * ⚠️ HOLDING_STATUSES exists twice: once in TypeScript, once as a SQL literal
 * in each of three partial unique index predicates. They are two statements
 * of one fact and nothing but this test holds them together. Drift means a
 * faction keeps or loses its flag, tag or pole in a state nobody intended.
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
    "factions_holding_pole_uniq",
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
});
