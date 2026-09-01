import { describe, it, expect, beforeEach, vi } from "vitest";
import { createClient, runMigrations, requireTestDatabaseUrl, servers, type Database } from "@factions/db";
import { sql } from "drizzle-orm";
import { ingestSweep } from "../src/sweep.js";
import type { NitradoLike } from "../src/tick.js";

const URL = requireTestDatabaseUrl();
const HOUR = 3_600_000;
const empty: NitradoLike = { listAdmFiles: async () => [], downloadFile: async () => "" };

describe("ingestSweep", () => {
  let db: Database;

  beforeEach(async () => {
    db = createClient(URL);
    await runMigrations(db);
    await db.execute(sql`truncate table events, raw_lines, adm_files, servers restart identity cascade`);
  });

  const addServer = (o: Record<string, unknown> = {}) => db.insert(servers).values({
    name: `S${Math.random()}`, map: "livonia", clockOffsetMs: 7 * HOUR, nitradoServiceId: 1, ...o,
  }).returning();

  it("sweeps every active server", async () => {
    await addServer();
    await addServer();
    const r = await ingestSweep(db, { clientFor: () => empty, backfillBudget: 15, failures: new Map() });
    expect(r.servers).toBe(2);
  });

  it("skips inactive servers", async () => {
    // The database decides which servers are swept, so retiring one is a
    // flag rather than a config edit or a row deletion.
    await addServer({ active: false });
    const r = await ingestSweep(db, { clientFor: () => empty, backfillBudget: 15, failures: new Map() });
    expect(r.servers).toBe(0);
  });

  it("skips active servers with no nitradoServiceId", async () => {
    // The `active` column was backfilled to true for every pre-existing row
    // when its NOT NULL DEFAULT true migration ran, including rows created
    // by the historical-export replay, which have no Nitrado service behind
    // them. Sweeping those would build an API client for a null service id
    // on every tick, forever.
    await addServer({ nitradoServiceId: null });
    const r = await ingestSweep(db, { clientFor: () => empty, backfillBudget: 15, failures: new Map() });
    expect(r.servers).toBe(0);
  });

  it("continues the sweep when one server fails", async () => {
    // ⚠️ One server's Nitrado outage must not stop every other server from
    // ingesting.
    const [bad] = await addServer();
    await addServer();
    const onServerError = vi.fn();
    const clientFor = (id: number): NitradoLike => id === 99
      ? { listAdmFiles: async () => { throw new Error("nitrado down"); }, downloadFile: async () => "" }
      : empty;
    await db.update(servers).set({ nitradoServiceId: 99 }).where(sql`id = ${bad!.id}`);
    const r = await ingestSweep(db, { clientFor, backfillBudget: 15, failures: new Map(), onServerError });
    expect(r.servers).toBe(2);
    expect(onServerError).toHaveBeenCalledTimes(1);
  });
});
