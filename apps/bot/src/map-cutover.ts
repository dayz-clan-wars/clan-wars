import type { Database } from "@factions/db";
import { servers } from "@factions/db";
import { eq } from "drizzle-orm";

/**
 * Stamp the instant a server changed map (Nasdara swap, spec §H). The
 * dormancy clock (`clockQuery` in dormancy-store.ts) floors every ACTIVE
 * clan's last raise at it, so the clans whose bases switch day cleared get
 * the full dormancy window to raise on the new map.
 *
 * Idempotent by its input, like `stampLaunchGrace`: the same instant is the
 * same stamp, so the runbook can re-run it. One statement on `servers`,
 * which no roster writer locks, so it sits outside the lock order.
 *
 * ⚠️ Throws on a server id that matches no row. A mistyped `--server` would
 * otherwise report success and leave the real server with no grace, and the
 * first sign would be every clan going dormant on the next tick.
 */
export async function setMapChangedAt(db: Database, serverId: number, at: Date): Promise<void> {
  const rows = await db.update(servers).set({ mapChangedAt: at }).where(eq(servers.id, serverId))
    .returning({ id: servers.id });
  if (rows.length === 0) throw new Error(`no server with id ${serverId}`);
}
