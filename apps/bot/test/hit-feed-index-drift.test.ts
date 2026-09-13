import { describe, it, expect, beforeAll } from "vitest";
import { createClient, runMigrations, type Database } from "@factions/db";
import { hitEventsQuery, maxOccurredAtQuery } from "../src/hit-feed-tick.js";

const URL = process.env.TEST_DATABASE_URL;
if (!URL) throw new Error("TEST_DATABASE_URL is required");

/**
 * ⚠️ `events_hit_id_idx` and `hitEventsQuery`'s predicate are two statements
 * of one fact: the event type `player.hit`. Nothing errors and no answer
 * changes if they drift apart — `PgHitFeedStore.readAfter` just walks the `id`
 * range from wherever the planner enters it, and once the frontier lags that
 * walk runs to the end of `events` for zero rows, once per tick, forever. This
 * has silently stopped a tick loop keeping up before (see CLAUDE.md, on the
 * dormancy clock's own index).
 *
 * ⚠️ `events_occurred_idx` guards `frontier()`'s STEADY-STATE branch — the
 * unqualified `max(occurred_at)` that runs on every tick where the kills
 * projector is caught up, which is most of them. `events_server_occurred_idx`
 * is keyed on `server_id` first and cannot answer a global max.
 */
describe("the hit feed's candidate read is index-backed", () => {
  let db: Database;
  beforeAll(async () => {
    db = createClient(URL);
    await runMigrations(db);
  });

  async function explain(text: string, params: unknown[]) {
    const client = (db as unknown as {
      $client: { unsafe: (q: string, p: unknown[]) => Promise<Record<string, string>[]> };
    }).$client;
    // ⚠️ Disabled, not forbidden: Postgres treats these as cost penalties, so
    // on the near-empty test table it still declines an index that cannot
    // actually answer the predicate.
    await client.unsafe("set enable_seqscan = off", []);
    await client.unsafe("set enable_bitmapscan = off", []);
    const plan = await client.unsafe(`explain ${text}`, params);
    return plan.map((r) => r["QUERY PLAN"] as string);
  }

  it("resolves the id range through the partial index, not a filter", async () => {
    const { sql: text, params } = hitEventsQuery(db, 0, new Date()).toSQL();
    const lines = await explain(text, params as unknown[]);
    const planText = lines.join("\n");

    expect(planText).toContain("events_hit_id_idx");

    const indexConds = lines.filter((l) => l.includes("Index Cond:")).join("\n");
    expect(indexConds).toContain("id >");

    // occurred_at is allowed as a Filter — it runs after the index has
    // already narrowed to player.hit rows above the cursor. It must never be
    // part of the Index Cond: the index is on `id` alone, and if the drift
    // signature ever shows occurred_at driving the scan instead, that means a
    // DIFFERENT, uncovering index took over silently.
    expect(indexConds).not.toContain("occurred_at");
  });

  it("resolves the steady-state global max through events_occurred_idx, not a sequential scan", async () => {
    const { sql: text, params } = maxOccurredAtQuery(db).toSQL();
    const lines = await explain(text, params as unknown[]);
    const planText = lines.join("\n");

    expect(planText).toContain("events_occurred_idx");
    expect(planText).not.toContain("Seq Scan on events");
  });
});
