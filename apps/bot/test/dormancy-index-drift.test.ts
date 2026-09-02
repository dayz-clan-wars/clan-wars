import { describe, it, expect, beforeAll } from "vitest";
import { createClient, runMigrations, factions, type Database } from "@factions/db";
import { inArray } from "drizzle-orm";
import { LAST_RAISE, EXAMINED } from "../src/dormancy-store.js";

const URL = process.env.TEST_DATABASE_URL;
if (!URL) throw new Error("TEST_DATABASE_URL is required");

/**
 * ⚠️ `events_raise_lookup_idx` and the LAST_RAISE subquery are two statements
 * of one fact: the event type `flag.raised` and the payload keys `poleKey` and
 * `texture`. Rename a key on one side and nothing errors and no answer changes
 * — the subquery just goes back to filtering every flag.raised row on the
 * server, once per faction, every tick. `guardedRunner` hides that by skipping
 * overlapping runs, so the dormancy clock would quietly stop keeping up.
 * Measured at 1M events / 120k raises / 45 factions: 352ms per tick without
 * the index, 0.4ms with it.
 *
 * Asserting the plan merely NAMES the index is not enough — `server_id` alone
 * keeps it usable, so a renamed payload key still produces an index scan. The
 * drift signature is the key moving out of `Index Cond` and into `Filter`,
 * which is what this asserts.
 */
describe("the dormancy clock's raise lookup is index-backed", () => {
  let db: Database;
  beforeAll(async () => {
    db = createClient(URL);
    await runMigrations(db);
  });

  it("resolves both payload keys through the index, not a filter", async () => {
    const { sql: text, params } = db
      .select({ id: factions.id, lastRaiseAt: LAST_RAISE })
      .from(factions)
      .where(inArray(factions.status, EXAMINED))
      .toSQL();

    const client = (db as unknown as {
      $client: { unsafe: (q: string, p: unknown[]) => Promise<Record<string, string>[]> };
    }).$client;
    // ⚠️ Disabled, not forbidden: Postgres treats these as cost penalties, so
    // on the near-empty test table it still declines an index that cannot
    // actually answer the predicate.
    await client.unsafe("set enable_seqscan = off", []);
    await client.unsafe("set enable_bitmapscan = off", []);
    const plan = await client.unsafe(`explain ${text}`, params as unknown[]);
    const lines = plan.map((r) => r["QUERY PLAN"] as string);
    const planText = lines.join("\n");

    expect(planText).toContain("events_raise_lookup_idx");

    const indexConds = lines.filter((l) => l.includes("Index Cond:")).join("\n");
    expect(indexConds).toContain("payload ->> 'poleKey'");
    expect(indexConds).toContain("payload ->> 'texture'");

    // Any payload comparison left as a Filter is a key the index no longer covers.
    expect(lines.filter((l) => /Filter:.*payload/.test(l))).toEqual([]);
  });
});
