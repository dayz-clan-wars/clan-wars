import { describe, it, expect, beforeEach } from "vitest";
import { createClient, runMigrations, requireTestDatabaseUrl, type Database } from "@factions/db";
import { KOTH_VOTE_TURNOUT_MIN } from "@factions/domain";
import { sql } from "drizzle-orm";

const URL = requireTestDatabaseUrl();

/**
 * ⚠️ `KOTH_VOTE_TURNOUT_MIN` exists twice: in rules.ts and as the literal in
 * `koth_votes_electorate_min`. Drift means a vote opens that can never pass, or a
 * legal one is refused by the database with a constraint error the player never
 * sees explained.
 */
describe("koth_votes_electorate_min matches KOTH_VOTE_TURNOUT_MIN", () => {
  let db: Database;
  beforeEach(async () => { db = createClient(URL); await runMigrations(db); });

  it("states the same minimum", async () => {
    const rows = await db.execute<{ def: string }>(sql`
      select pg_get_constraintdef(oid) as def from pg_constraint where conname = 'koth_votes_electorate_min'`);
    const def = [...rows][0]?.def ?? "";
    expect(def).toMatch(new RegExp(`>= ${KOTH_VOTE_TURNOUT_MIN}\\b`));
  });

  it("backfills origin on an old-shaped insert", async () => {
    await db.execute(sql`truncate table koth_events, servers restart identity cascade`);
    await db.execute(sql`insert into servers (name, map, clock_offset_ms, nitrado_service_id, active) values ('R','livonia',0,7,true)`);
    await db.execute(sql`insert into koth_events (server_id, slot_at, location, centre_x, centre_z, state, scheduled_by_discord_id)
      values (1, '2026-10-03T20:00:00Z', 'lembork', 1, 1, 'scheduled', '99')`);
    const [row] = [...await db.execute<{ origin: string }>(sql`select origin from koth_events`)];
    expect(row!.origin).toBe("admin");
  });

  it("refuses an auto row with a scheduler, and an admin row without one", async () => {
    await db.execute(sql`truncate table koth_events, servers restart identity cascade`);
    await db.execute(sql`insert into servers (name, map, clock_offset_ms, nitrado_service_id, active) values ('R','livonia',0,7,true)`);
    await expect(db.execute(sql`insert into koth_events (server_id, slot_at, location, centre_x, centre_z, state, origin, scheduled_by_discord_id)
      values (1, '2026-10-03T20:00:00Z', 'lembork', 1, 1, 'scheduled', 'auto', '99')`)).rejects.toThrow(/koth_events_origin_scheduler/);
    await expect(db.execute(sql`insert into koth_events (server_id, slot_at, location, centre_x, centre_z, state, origin)
      values (1, '2026-10-03T20:00:00Z', 'lembork', 1, 1, 'scheduled', 'admin')`)).rejects.toThrow(/koth_events_origin_scheduler/);
  });
});
