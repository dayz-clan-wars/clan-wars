import type { Database } from "@factions/db";
import { poles } from "@factions/db";
import { NEW_POLE_GRACE_MS } from "@factions/domain";
import { lockDeclarations } from "@factions/declarations";
import { eq } from "drizzle-orm";

type Tx = Parameters<Parameters<Database["transaction"]>[0]>[0];

export type LaunchResult = {
  polesStamped: number;
  graceUntil: Date;
};

/**
 * The launch grace stamp (spec §4.2): every pole the log has ever seen on
 * this server gets `grace_until = launch + NEW_POLE_GRACE_MS`, so no base is
 * public on the map before players have had the guide's seven days to
 * declare. Grace only — flags, textures and sighting times are untouched,
 * and a pole that already carries a declaration is unaffected in practice
 * (publication needs no declaration row, §4.2).
 *
 * Idempotent by its input: the same `launchAt` yields the same stamp, so the
 * runbook can re-run it. A different `launchAt` re-stamps on purpose — the
 * launch instant is the argument, never "now" (see scripts/launch.ts).
 *
 * Lock order §4.12: `lockDeclarations` (the server's advisory lock) before
 * `poles`, the same order `wipeTx` and every declarer take, so the stamp
 * serialises against a declaration in flight even though the runbook stops
 * the bot first.
 */
export async function stampLaunchGraceTx(tx: Tx, serverId: number, launchAt: Date): Promise<LaunchResult> {
  await lockDeclarations(tx, serverId);
  const graceUntil = new Date(launchAt.getTime() + NEW_POLE_GRACE_MS);
  const rows = await tx.update(poles)
    .set({ graceUntil })
    .where(eq(poles.serverId, serverId))
    .returning({ id: poles.id });
  return { polesStamped: rows.length, graceUntil };
}

export async function stampLaunchGrace(db: Database, serverId: number, launchAt: Date): Promise<LaunchResult> {
  return db.transaction((tx) => stampLaunchGraceTx(tx, serverId, launchAt));
}
