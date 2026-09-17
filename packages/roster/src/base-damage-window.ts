import type { Database } from "@factions/db";
import { raidWindowFlips, raidWindowSkips } from "@factions/db";
import { raidWindowAt } from "@factions/domain";
import { and, eq, isNotNull } from "drizzle-orm";

export type BaseDamageWindow = {
  status: "live" | "closed" | "unconfirmed" | "skipped";
  opensAt: Date;
  closesAt: Date;
  skipReason?: string;
};

/**
 * Whether base damage is actually on, for the site's status strip.
 *
 * ⚠️ Reads a CONFIRMED flip, not the clock's guess. "It is Friday, therefore
 * raiding is live" is wrong at exactly the moment it matters — a failed flip
 * — and a player finds out by swinging at a wall. `unconfirmed` is the honest
 * answer when the boundary has passed and nothing recorded a successful,
 * restart-confirmed flip for it.
 *
 * ⚠️ `state.boundaryAt` is read as-is, never re-derived here. The flip writer
 * (`restart-tick.ts`) keys its row on that same value; a locally recomputed
 * instant disagreed with it for midweek cases during an earlier scan and would
 * leave this read permanently answering "unconfirmed".
 */
export async function baseDamageWindowDb(db: Database, now: Date): Promise<BaseDamageWindow> {
  const skips = await db
    .select({ opensAt: raidWindowSkips.opensAt, reason: raidWindowSkips.reason })
    .from(raidWindowSkips);
  const state = raidWindowAt(now, skips);

  if (state.phase === "skipped") {
    return { status: "skipped", opensAt: state.opensAt, closesAt: state.closesAt, skipReason: state.skipReason };
  }

  const [row] = await db
    .select({ serverId: raidWindowFlips.serverId })
    .from(raidWindowFlips)
    .where(and(
      eq(raidWindowFlips.boundaryAt, state.boundaryAt),
      eq(raidWindowFlips.outcome, "applied"),
      isNotNull(raidWindowFlips.restartConfirmedAt),
    ))
    .limit(1);

  if (!row) {
    return { status: "unconfirmed", opensAt: state.opensAt, closesAt: state.closesAt };
  }
  return {
    status: state.phase === "open" ? "live" : "closed",
    opensAt: state.opensAt,
    closesAt: state.closesAt,
  };
}
