import type { Database } from "@factions/db";
import { servers } from "@factions/db";
import { and, asc, eq, isNotNull } from "drizzle-orm";

/**
 * One server as the site's strip shows it: the in-game name Nitrado last
 * reported (the string players search for in the DayZ browser), its map,
 * and when the worker last confirmed the name. `seenAt` is what lets the
 * strip say how fresh the name is, since a Nitrado outage keeps the last
 * good value rather than blanking it.
 */
export type LiveServer = { hostname: string; map: string; seenAt: Date };

/**
 * Active servers that have a Nitrado service and whose name the worker has
 * read at least once, oldest registration first. Replay rows (no service)
 * and freshly registered servers (no sweep yet) are left out: there is no
 * name to show for either, and inventing one would be the failure the
 * column's nullability exists to prevent.
 */
export async function liveServersDb(db: Database): Promise<LiveServer[]> {
  const rows = await db.select({ hostname: servers.hostname, map: servers.map, seenAt: servers.hostnameSeenAt })
    .from(servers)
    .where(and(eq(servers.active, true), isNotNull(servers.nitradoServiceId), isNotNull(servers.hostname), isNotNull(servers.hostnameSeenAt)))
    .orderBy(asc(servers.id));
  return rows.map((r) => ({ hostname: r.hostname!, map: r.map, seenAt: r.seenAt! }));
}
