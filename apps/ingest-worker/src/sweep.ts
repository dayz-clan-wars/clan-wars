import type { Database } from "@factions/db";
import { servers } from "@factions/db";
import { and, eq, isNotNull } from "drizzle-orm";
import { ingestTick, type NitradoLike } from "./tick.js";

export type ClientFactory = (nitradoServiceId: number) => NitradoLike;

export type SweepDeps = {
  clientFor: ClientFactory;
  backfillBudget: number;
  /** Called when one server's tick throws; the sweep continues with the rest. */
  onServerError?: (serverId: number, err: unknown) => void;
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
      });
    } catch (err) {
      deps.onServerError?.(s.id, err);
    }
  }
  return { servers: active.length };
}
