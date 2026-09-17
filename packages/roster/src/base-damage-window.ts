import type { Database } from "@factions/db";
import { raidWindowFlips, raidWindowSkips } from "@factions/db";
import { raidWindowAt } from "@factions/domain";
import { and, eq, isNotNull } from "drizzle-orm";

export type BaseDamageWindow = {
  status: "live" | "closed" | "unconfirmed" | "skipped";
  /**
   * Which flip is missing. Set ONLY when status is "unconfirmed".
   *
   * ⚠️ The strip needs the direction: an unconfirmed CLOSE leaves base damage ON,
   * and calling that "OPENING" is wrong half the time. Carried from the phase the
   * domain already computed rather than re-derived from the two instants at the
   * render site — re-derivation is the drift this feature has a ⚠️ about in three
   * other places.
   */
  pending?: "open" | "close";
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

  // ⚠️ ANY server's confirmed flip answers for the whole site. Known limitation,
  // accepted because there is one registered server and one host: with two, one
  // server's confirmed flip would make the strip say LIVE while the other server's
  // failed flip leaves its players swinging at walls. Scope this per server — and
  // give the strip a server — before a second one is registered.
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
    return {
      status: "unconfirmed",
      pending: state.phase === "open" ? "open" : "close",
      opensAt: state.opensAt,
      closesAt: state.closesAt,
    };
  }
  return {
    status: state.phase === "open" ? "live" : "closed",
    opensAt: state.opensAt,
    closesAt: state.closesAt,
  };
}
