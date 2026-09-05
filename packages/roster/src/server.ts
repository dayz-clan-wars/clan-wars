import type { Database } from "@factions/db";
import { servers } from "@factions/db";
import type { Tx } from "@factions/declarations";
import { asc, eq } from "drizzle-orm";

/**
 * The server the site acts on. This deployment registers exactly one; the
 * ORDER BY makes a second one a deterministic choice rather than a random
 * one, and the throw makes an empty `servers` table a loud failure instead
 * of a page that quietly declares nothing.
 */
export async function activeServerId(db: Database | Tx): Promise<number> {
  const [s] = await db.select({ id: servers.id }).from(servers)
    .where(eq(servers.active, true)).orderBy(asc(servers.id)).limit(1);
  if (!s) throw new Error("no active server is registered; the site cannot act without one");
  return s.id;
}
