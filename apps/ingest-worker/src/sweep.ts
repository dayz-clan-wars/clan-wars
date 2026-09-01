import type { Database } from "@factions/db";
import { servers } from "@factions/db";
import { and, eq, isNotNull } from "drizzle-orm";
import { ingestTick, type NitradoLike } from "./tick.js";
import { supplyTick, type SupplyUploader, type SupplyTickResult } from "./supply-tick.js";
import type { SpawnObject } from "./supplies.js";

export type ClientFactory = (nitradoServiceId: number) => NitradoLike;

export type SweepDeps = {
  clientFor: ClientFactory;
  backfillBudget: number;
  /**
   * Per-file consecutive failure counts, shared across every server and every
   * sweep. Owned by main.ts for the process lifetime — see TickDeps.
   */
  failures: Map<string, number>;
  /** Called when one server's tick throws; the sweep continues with the rest. */
  onServerError?: (serverId: number, err: unknown) => void;
  /** Absent in tests that only exercise ingestion. */
  supplies?: {
    clientFor: (nitradoServiceId: number) => SupplyUploader;
    offsets: SpawnObject[];
    remoteDir: string;
    fileName: string;
  };
  onSupplyError?: (serverId: number, err: unknown) => void;
  /**
   * Called only when the supply tick actually uploaded. Without it a
   * successful upload is invisible: the sweep discards SupplyTickResult, so
   * only failures ever reach the log and an operator cannot tell from the
   * logs that a claim produced a file.
   */
  onSupplyUploaded?: (serverId: number, result: SupplyTickResult) => void;
};

/** One sweep across every active server. The database decides which those are. */
export async function ingestSweep(db: Database, deps: SweepDeps): Promise<{ servers: number }> {
  const active = await db.select().from(servers).where(and(
    eq(servers.active, true),
    // ⚠️ `active` alone is not enough. The `NOT NULL DEFAULT true` migration
    // on `servers.active` backfilled every pre-existing row to true,
    // including rows created by the historical-export replay from local
    // disk, which predate Nitrado ingestion and have nitrado_service_id =
    // NULL. Without this filter the sweep would try to build an API client
    // for a null service id on every one of those rows, every tick, forever.
    isNotNull(servers.nitradoServiceId),
  ));
  for (const s of active) {
    // ⚠️ Per-server isolation. One server's Nitrado outage must not abort the
    // sweep and leave every other server un-ingested.
    try {
      await ingestTick(db, {
        serverId: s.id,
        client: deps.clientFor(s.nitradoServiceId!),
        backfillBudget: deps.backfillBudget,
        failures: deps.failures,
      });
    } catch (err) {
      deps.onServerError?.(s.id, err);
    }

    // ⚠️ Its own try/catch, and it runs after ingestion. A Nitrado
    // file-server outage must not cost us log events: supplies reappear at
    // the next restart, missing events never do.
    if (deps.supplies) {
      try {
        const result = await supplyTick(db, {
          serverId: s.id,
          client: deps.supplies.clientFor(s.nitradoServiceId!),
          offsets: deps.supplies.offsets,
          // ⚠️ SINGLE-SERVER ONLY. `remoteDir` is one process-wide value
          // (MISSION_CUSTOM_DIR) handed to EVERY server in this loop, but the
          // path is service-specific — it embeds the Nitrado service id. With
          // one active server this is correct. With two, the second server's
          // file goes into the first service's directory, and if that path
          // exists the upload SUCCEEDS silently into a folder the second
          // server never reads: no error, the hash advances, and its supplies
          // simply never appear. Fixing it properly means a per-server column
          // (a schema change). See PLAN-3-INBOX item 23 and config.ts.
          remoteDir: deps.supplies.remoteDir,
          fileName: deps.supplies.fileName,
          now: new Date(),
        });
        if (result.uploaded) deps.onSupplyUploaded?.(s.id, result);
      } catch (err) {
        deps.onSupplyError?.(s.id, err);
      }
    }
  }
  return { servers: active.length };
}
