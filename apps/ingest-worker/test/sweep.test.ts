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

  const baseDeps = { clientFor: () => empty, backfillBudget: 15, failures: new Map<string, number>() };

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

  it("runs the supply tick for each server", async () => {
    await addServer();
    const seen: number[] = [];
    await ingestSweep(db, {
      ...baseDeps,
      supplies: { offsets: [], remoteDir: "/d", fileName: "f.json", clientFor: () => ({ uploadFile: async () => { seen.push(1); } }) },
    });
    expect(seen.length).toBeGreaterThan(0);
  });

  it("reports an upload once, and stays quiet when nothing changed", async () => {
    // ⚠️ The sweep discards SupplyTickResult, so without this callback a
    // successful upload leaves NO trace in the log at all — only failures do,
    // and an operator cannot tell that a claim produced a file.
    //
    // The second sweep is the half that keeps this honest: a callback fired
    // unconditionally (rather than on `uploaded`) would pass the first
    // assertion and log on every tick forever.
    const [srv] = await addServer();
    const onSupplyUploaded = vi.fn();
    const supplies = {
      offsets: [], remoteDir: "/d", fileName: "f.json",
      clientFor: () => ({ uploadFile: async () => {} }),
    };
    await ingestSweep(db, { ...baseDeps, supplies, onSupplyUploaded });
    expect(onSupplyUploaded).toHaveBeenCalledTimes(1);
    expect(onSupplyUploaded.mock.calls[0]![0]).toBe(srv!.id);
    expect(onSupplyUploaded.mock.calls[0]![1]).toMatchObject({ uploaded: true });

    // Same roster, same bytes, same hash: no upload, so nothing to report.
    await ingestSweep(db, { ...baseDeps, supplies, onSupplyUploaded });
    expect(onSupplyUploaded).toHaveBeenCalledTimes(1);
  });

  it("keeps ingesting when the supply tick throws", async () => {
    // ⚠️ A Nitrado file-server outage must not stop log ingestion. Supplies
    // are cosmetic; missing events are permanent.
    await addServer();
    const errors: unknown[] = [];
    const r = await ingestSweep(db, {
      ...baseDeps,
      supplies: { offsets: [], remoteDir: "/d", fileName: "f.json", clientFor: () => ({ uploadFile: async () => { throw new Error("boom"); } }) },
      onSupplyError: (_id, err) => errors.push(err),
    });
    expect(r.servers).toBeGreaterThan(0);
    expect(errors).toHaveLength(1);
  });
});
