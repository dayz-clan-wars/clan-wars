import type { Database } from "@factions/db";
import { seasons } from "@factions/db";
import { and, eq, isNull } from "drizzle-orm";

type Tx = Parameters<Parameters<Database["transaction"]>[0]>[0];

/** The one open season on a server (seasons_open_uniq), or null before the runbook opens season 1. */
export async function openSeason(db: Database | Tx, serverId: number): Promise<{ id: number; number: number; startedAt: Date } | null> {
  const [s] = await db.select({ id: seasons.id, number: seasons.number, startedAt: seasons.startedAt })
    .from(seasons).where(and(eq(seasons.serverId, serverId), isNull(seasons.endedAt)));
  return s ?? null;
}
