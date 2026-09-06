import type { Database } from "@factions/db";
import { declarations, factions, identityHolds, poles, seasons } from "@factions/db";
import { POST_WIPE_BIND_MS } from "@factions/domain";
import { lockDeclarations } from "@factions/declarations";
import { and, eq, sql } from "drizzle-orm";
import { closeSeasonTx } from "./season-close.js";

type Tx = Parameters<Parameters<Database["transaction"]>[0]>[0];

export type WipeResult = {
  skipped: boolean;
  closedSeason: number | null;
  openedSeason: number;
  holdsEnded: number;
  declarationsDeleted: number;
  polesStamped: number;
  clansCleared: number;
};

/**
 * The wipe (spec §8.5), in one transaction: close the season, end every
 * identity hold, clear every declaration, re-bind every pole, clear the
 * per-clan wipe-scoped flags, and open the next season. The bot is stopped
 * per the runbook before this runs, but the function still takes the same
 * locks a live writer would (lock order §4.12): `factions` FOR UPDATE first,
 * then `lockDeclarations`'s advisory lock before touching `declarations`.
 *
 * `clan_pins` and `intruder_sightings` do not exist yet — increment 5's plan
 * adds them, and its wipe step (5) clears them here too.
 *
 * No-op (`skipped: true`) when a season with `started_at = wipeAt` already
 * exists on the server — the signature of this exact wipe already having
 * run. Checked FIRST, before any lock or write, so a re-run (the runbook's
 * own retry, or a second operator) touches nothing: not the season table,
 * not a #war-log line, not a single row this wipe would otherwise re-clear.
 */
export async function wipeTx(tx: Tx, serverId: number, wipeAt: Date): Promise<WipeResult> {
  const [already] = await tx.select({ id: seasons.id, number: seasons.number })
    .from(seasons)
    .where(and(eq(seasons.serverId, serverId), eq(seasons.startedAt, wipeAt)));
  if (already) {
    return {
      skipped: true, closedSeason: null, openedSeason: already.number,
      holdsEnded: 0, declarationsDeleted: 0, polesStamped: 0, clansCleared: 0,
    };
  }

  // (0) Lock order §4.12: factions first.
  await tx.select({ id: factions.id }).from(factions).where(eq(factions.serverId, serverId)).for("update");

  // (1) Close the open season, if any.
  const closed = await closeSeasonTx(tx, serverId, wipeAt);

  // (2) End every live identity hold. Compared in SQL against the
  // 'infinity' sentinel — postgres.js hands that back as an invalid Date.
  const heldRows = await tx.update(identityHolds)
    .set({ heldUntil: wipeAt })
    .where(and(eq(identityHolds.serverId, serverId), sql`${identityHolds.heldUntil} = 'infinity'`))
    .returning({ id: identityHolds.id });

  // (3) Clear every declaration, after taking the declarations advisory lock.
  await lockDeclarations(tx, serverId);
  const declRows = await tx.delete(declarations).where(eq(declarations.serverId, serverId)).returning({ id: declarations.id });

  // (4) Re-bind every pole: fresh post-wipe grace, flag down.
  const poleRows = await tx.update(poles)
    .set({ graceUntil: new Date(wipeAt.getTime() + POST_WIPE_BIND_MS), flagRaised: false })
    .where(eq(poles.serverId, serverId))
    .returning({ id: poles.id });

  // (5) Clear the per-clan wipe-scoped flags. Statuses are untouched — a
  // dormant clan stays dormant, an active one stays active.
  const clanRows = await tx.update(factions)
    .set({ flagDownSince: null, flagDownByDayzId: null, disbandWarnedAt: null })
    .where(eq(factions.serverId, serverId))
    .returning({ id: factions.id });

  // (6) Open the next season.
  const nextNumber = closed ? closed.number + 1 : 1;
  const [opened] = await tx.insert(seasons)
    .values({ serverId, number: nextNumber, startedAt: wipeAt })
    .returning({ id: seasons.id, number: seasons.number });

  return {
    skipped: false,
    closedSeason: closed?.number ?? null,
    openedSeason: opened!.number,
    holdsEnded: heldRows.length,
    declarationsDeleted: declRows.length,
    polesStamped: poleRows.length,
    clansCleared: clanRows.length,
  };
}

export async function wipe(db: Database, serverId: number, wipeAt: Date): Promise<WipeResult> {
  return db.transaction((tx) => wipeTx(tx, serverId, wipeAt));
}
