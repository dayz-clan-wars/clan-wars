import type { Database } from "@factions/db";
import { servers } from "@factions/db";
import { and, eq, isNotNull } from "drizzle-orm";
import { ingestTick, type NitradoLike } from "./tick.js";
import { supplyTick, type SupplyUploader, type SupplyTickResult, type SupplyDrift } from "./supply-tick.js";
import type { SpawnObject } from "./supplies.js";

export type ClientFactory = (nitradoServiceId: number) => NitradoLike;

/**
 * What the sweep needs of a server's Nitrado client for supplies: somewhere to
 * write, and the ability to say where that is.
 *
 * ⚠️ `missionCustomDir` lives here and NOT on `SupplyUploader`, which
 * `supplyTick` takes: the tick only ever writes, and widening its dependency
 * to something it does not call would make every one of its tests carry a stub
 * for a method under test nowhere.
 */
export type SupplyClient = SupplyUploader & {
  /**
   * This server's own mission custom directory. Asked per server rather than
   * configured once: the path embeds the gameserver's username, so a single
   * process-wide value is correct for exactly one server and silently wrong
   * for every other. See the call site below.
   */
  missionCustomDir(): Promise<string>;
};

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
    clientFor: (nitradoServiceId: number) => SupplyClient;
    offsets: SpawnObject[];
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
  /**
   * Called when the file on the game server is not the one we last uploaded.
   * The tick repairs it either way; this exists so the repair is not silent —
   * whatever rewrote the file (a mission wipe, an FTP restore, a Nitrado
   * rollback) has almost certainly touched more than this one file.
   */
  onSupplyDrift?: (serverId: number, drift: SupplyDrift) => void;
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
        const client = deps.supplies.clientFor(s.nitradoServiceId!);
        // ⚠️ Per server, from that server's own Nitrado service. This used to
        // be one process-wide MISSION_CUSTOM_DIR handed to every server in
        // this loop, which was correct for exactly one: the path embeds the
        // gameserver's USERNAME, so the second server's file went into the
        // first's directory — and if that directory exists under the second
        // service's credentials the upload SUCCEEDS, the hash advances, and
        // its supplies simply never appear, with nothing in the log.
        //
        // A throw here skips only this server's supplies, by the same
        // reasoning as the catch below: no fallback directory, because
        // uploading to the wrong one is the failure being prevented.
        const remoteDir = await client.missionCustomDir();
        const result = await supplyTick(db, {
          serverId: s.id,
          client,
          offsets: deps.supplies.offsets,
          remoteDir,
          fileName: deps.supplies.fileName,
          now: new Date(),
          onDrift: (d) => deps.onSupplyDrift?.(s.id, d),
        });
        if (result.uploaded) deps.onSupplyUploaded?.(s.id, result);
      } catch (err) {
        deps.onSupplyError?.(s.id, err);
      }
    }
  }
  return { servers: active.length };
}
