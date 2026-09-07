import type { Database } from "@factions/db";
import { alphaWeeks, seasons } from "@factions/db";
import { weekStartOf } from "@factions/domain";
import { appendWarLogTx } from "@factions/roster/internal";
import { eq, isNull } from "drizzle-orm";
import { weekTopThree } from "./standings.js";

type Tx = Parameters<Parameters<Database["transaction"]>[0]>[0];

const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

/** The Monday after `weekStart`. */
export function nextWeek(weekStart: Date): Date {
  return new Date(weekStart.getTime() + WEEK_MS);
}

export type WeekTickResult = { closed: number; errors: number };

/** Carries the week that failed out of `closeWeeksTx` so the tick can report it. */
class WeekCloseError extends Error {
  readonly weekStart: Date;
  readonly reason: unknown;
  constructor(weekStart: Date, reason: unknown) {
    super(`week close failed for ${weekStart.toISOString()}`);
    this.name = "WeekCloseError";
    this.weekStart = weekStart;
    this.reason = reason;
  }
}

export type OpenSeasonRow = {
  id: number;
  serverId: number;
  startedAt: Date;
  weekClosedThrough: Date | null;
};

/**
 * Close every week of one season whose end (`nextWeek(w)`) is `<= now`, in
 * order, inside the caller's transaction. Returns the number closed.
 *
 * Locks the season row FOR UPDATE and re-reads `week_closed_through` from
 * under that lock (a second instance, or a replay of this tick, may already
 * have closed some of them) — `season.weekClosedThrough` is only the caller's
 * hint. Re-taking the lock is safe when the caller already holds it (the
 * wipe does, per §4.12), because a row lock is re-entrant within one
 * transaction.
 *
 * Two callers: `weekTick` below, once per open season, and `wipeTx`, with
 * `now = wipeAt`, so the season's last elapsed week still crowns its Alphas
 * before `closeSeasonTx` sets `ended_at` and puts the season out of the
 * tick's reach forever.
 */
export async function closeWeeksTx(tx: Tx, season: OpenSeasonRow, now: Date): Promise<number> {
  const [locked] = await tx.select({ weekClosedThrough: seasons.weekClosedThrough })
    .from(seasons).where(eq(seasons.id, season.id)).for("update");
  if (!locked) return 0;

  let closed = 0;
  let w = locked.weekClosedThrough === null ? weekStartOf(season.startedAt) : nextWeek(locked.weekClosedThrough);
  while (nextWeek(w) <= now) {
    const thisWeek = w;
    try {
      const top = await weekTopThree(tx, season.id, thisWeek);
      if (top.length > 0) {
        await tx.insert(alphaWeeks).values(top.map((t, i) => ({
          seasonId: season.id, weekStart: thisWeek, rank: i + 1, factionId: t.factionId, points: t.points,
        }))).onConflictDoNothing({ target: [alphaWeeks.seasonId, alphaWeeks.weekStart, alphaWeeks.rank] });
      }
      await appendWarLogTx(tx, {
        serverId: season.serverId, kind: "week_closed", occurredAt: nextWeek(thisWeek),
        payload: {
          weekStart: thisWeek.toISOString(),
          first: top[0]?.name ?? null, second: top[1]?.name ?? null, third: top[2]?.name ?? null,
          p1: top[0]?.points ?? null, p2: top[1]?.points ?? null, p3: top[2]?.points ?? null,
        },
      });
      await tx.update(seasons).set({ weekClosedThrough: thisWeek }).where(eq(seasons.id, season.id));
    } catch (err) {
      throw new WeekCloseError(thisWeek, err);
    }
    closed++;
    w = nextWeek(thisWeek);
  }
  return closed;
}

/**
 * The week-close job (spec §7 vs §4.8 ruling, increment 4 task 3). For every
 * open season, `closeWeeksTx` closes each week from its high-water mark up to
 * the last week whose end is `<= now`, in one transaction per season: lock the
 * season row, re-read `week_closed_through`, compute the top three (Task 2's
 * `weekTopThree`), insert their `alpha_weeks` rows (idempotent on the unique
 * key), queue the `#war-log` line, and advance the high-water mark. An error
 * closing one week rolls that season's transaction back and stops that
 * season's loop for this tick — weeks must close in order — but does not stop
 * any other season's; the next tick retries from the committed high-water mark.
 */
export async function weekTick(db: Database, opts: { now: Date; onError?: (seasonId: number, weekStart: Date, err: unknown) => void }): Promise<WeekTickResult> {
  const out: WeekTickResult = { closed: 0, errors: 0 };
  const openSeasons = await db.select({
    id: seasons.id, serverId: seasons.serverId, startedAt: seasons.startedAt, weekClosedThrough: seasons.weekClosedThrough,
  }).from(seasons).where(isNull(seasons.endedAt));

  for (const season of openSeasons) {
    try {
      out.closed += await db.transaction((tx) => closeWeeksTx(tx, season, opts.now));
    } catch (err) {
      out.errors++;
      if (err instanceof WeekCloseError) opts.onError?.(season.id, err.weekStart, err.reason);
      else opts.onError?.(season.id, weekStartOf(opts.now), err);
    }
  }
  return out;
}
