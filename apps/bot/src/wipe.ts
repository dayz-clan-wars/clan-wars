import type { Database } from "@factions/db";
import { clanPins, declarations, factions, identityHolds, intruderSightings, poles, seasons } from "@factions/db";
import { POST_WIPE_BIND_MS } from "@factions/domain";
import { lockDeclarations } from "@factions/declarations";
import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import { closeSeasonTx } from "./season-close.js";
import { closeWeeksTx } from "./week-tick.js";

type Tx = Parameters<Parameters<Database["transaction"]>[0]>[0];

export type WipeResult = {
  skipped: boolean;
  closedSeason: number | null;
  openedSeason: number;
  holdsEnded: number;
  declarationsDeleted: number;
  polesStamped: number;
  clansCleared: number;
  weeksClosed: number;
  pinsCleared: number;
  sightingsCleared: number;
};

/**
 * A wipe never closes a season younger than this. The wipe opens the new
 * season with `started_at = wipe_at` and stamps every pole with the same
 * 7-day post-wipe bind grace (§8.5 step 4), so an open season still inside
 * that grace is one THIS wipe just opened: a re-run, not the next season
 * boundary. Seasons run wipe to wipe — months — so no real boundary is ever
 * this close to the previous one.
 */
const WIPE_RERUN_WINDOW_MS = POST_WIPE_BIND_MS;

/**
 * The wipe (spec §8.5), in one transaction: close every week of the season
 * that has already elapsed, close the season, end every identity hold, clear
 * every declaration, re-bind every pole, clear the per-clan wipe-scoped
 * flags, and open the next season. The bot is stopped per the runbook before
 * this runs, but the function still takes the same locks a live writer would
 * (lock order §4.12): `factions` FOR UPDATE first, then the open `seasons`
 * row, then `lockDeclarations`'s advisory lock before touching
 * `declarations`.
 *
 * No-op (`skipped: true`) when the server's open season is one a wipe just
 * opened — its `started_at` is at or after `wipeAt`, or within
 * `WIPE_RERUN_WINDOW_MS` before it. §8.5 makes the wipe "idempotent by the
 * season it closes", and after a first run the season on offer is the one
 * that run created; closing it would clear declarations clans re-bound after
 * the restart, queue a second `season_closed` line and open a third season.
 * The guard is read UNDER the `factions` and `seasons` locks, so a second
 * invocation that raced the first blocks, then sees the committed new season
 * and skips — the pre-lock check it replaces was a TOCTOU on the one
 * destructive path.
 */
export async function wipeTx(tx: Tx, serverId: number, wipeAt: Date): Promise<WipeResult> {
  // (0) Lock order §4.12: factions first, then the server's open season.
  const factionRows = await tx.select({ id: factions.id }).from(factions).where(eq(factions.serverId, serverId)).for("update");
  const factionIds = factionRows.map((f) => f.id);

  const [open] = await tx.select({
    id: seasons.id, number: seasons.number, serverId: seasons.serverId,
    startedAt: seasons.startedAt, weekClosedThrough: seasons.weekClosedThrough,
  }).from(seasons)
    .where(and(eq(seasons.serverId, serverId), isNull(seasons.endedAt)))
    .for("update");

  // (1) The idempotency guard, re-checked here under the locks.
  if (open && wipeAt.getTime() < open.startedAt.getTime() + WIPE_RERUN_WINDOW_MS) {
    return {
      skipped: true, closedSeason: null, openedSeason: open.number,
      holdsEnded: 0, declarationsDeleted: 0, polesStamped: 0, clansCleared: 0, weeksClosed: 0,
      pinsCleared: 0, sightingsCleared: 0,
    };
  }

  // (2) Close every week of the open season that has already elapsed (§8.3):
  // once `ended_at` is set, the week tick — which only walks open seasons —
  // can never crown these Alphas. Same transaction, and the season row is
  // already locked above.
  const weeksClosed = open ? await closeWeeksTx(tx, open, wipeAt) : 0;

  // (3) Close the open season, if any.
  const closed = await closeSeasonTx(tx, serverId, wipeAt);

  // (4) End every live identity hold. Compared in SQL against the
  // 'infinity' sentinel — postgres.js hands that back as an invalid Date.
  const heldRows = await tx.update(identityHolds)
    .set({ heldUntil: wipeAt })
    .where(and(eq(identityHolds.serverId, serverId), sql`${identityHolds.heldUntil} = 'infinity'`))
    .returning({ id: identityHolds.id });

  // (5) Clear every declaration, after taking the declarations advisory lock.
  await lockDeclarations(tx, serverId);
  const declarationIds = (await tx.select({ id: declarations.id }).from(declarations).where(eq(declarations.serverId, serverId))).map((d) => d.id);

  // (5) The map's wipe-scoped state (§8.5): every pin and every sighting on
  // this server. Sightings cascade with the declarations deleted below;
  // the explicit delete keeps the step honest if that cascade ever changes.
  //
  // ⚠️ These two deletes sit BEFORE step (6)'s `poles` update, which inverts
  // §4.12's poles-before-the-new-tables order inside this one transaction.
  // That cannot deadlock: no counterparty acquires `poles` after
  // `clan_pins` or `intruder_sightings` — the site's pin writes and the zone
  // consumer take no pole lock at all — so there is no other transaction
  // holding `poles` and waiting on either table. Keep it that way; a future
  // writer that touches `poles` after these tables would make this an
  // ordering bug, and then this block moves after step (6).
  const pinsCleared = (await tx.delete(clanPins).where(inArray(clanPins.factionId, factionIds)).returning({ id: clanPins.id })).length;
  const sightingsCleared = (await tx.delete(intruderSightings).where(inArray(intruderSightings.declarationId, declarationIds)).returning({ id: intruderSightings.id })).length;

  const declRows = await tx.delete(declarations).where(eq(declarations.serverId, serverId)).returning({ id: declarations.id });

  // (6) Re-bind every pole: fresh post-wipe grace, flag down.
  const poleRows = await tx.update(poles)
    .set({ graceUntil: new Date(wipeAt.getTime() + POST_WIPE_BIND_MS), flagRaised: false })
    .where(eq(poles.serverId, serverId))
    .returning({ id: poles.id });

  // (7) Clear the per-clan wipe-scoped flags. Statuses are untouched — a
  // dormant clan stays dormant, an active one stays active.
  const clanRows = await tx.update(factions)
    .set({ flagDownSince: null, flagDownByDayzId: null, disbandWarnedAt: null })
    .where(eq(factions.serverId, serverId))
    .returning({ id: factions.id });

  // (8) Open the next season.
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
    weeksClosed,
    pinsCleared,
    sightingsCleared,
  };
}

export async function wipe(db: Database, serverId: number, wipeAt: Date): Promise<WipeResult> {
  return db.transaction((tx) => wipeTx(tx, serverId, wipeAt));
}
