import type { Database } from "@factions/db";
import { alphaWeeks, seasons } from "@factions/db";
import { weekStartOf } from "@factions/domain";
import { appendWarLogTx } from "@factions/roster/internal";
import { eq, isNull } from "drizzle-orm";
import { weekTopThree } from "./standings.js";

const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

/** The Monday after `weekStart`. */
export function nextWeek(weekStart: Date): Date {
  return new Date(weekStart.getTime() + WEEK_MS);
}

export type WeekTickResult = { closed: number; errors: number };

/**
 * The week-close job (spec §7 vs §4.8 ruling, increment 4 task 3). For every
 * open season, close each week from its high-water mark up to the last week
 * whose end (`nextWeek(w)`) is `<= now`, in order, one transaction per week:
 * lock the season row, re-read `week_closed_through` (a second instance or a
 * replay may already have closed `w`), compute the top three (Task 2's
 * `weekTopThree`), insert their `alpha_weeks` rows (idempotent on the unique
 * key), queue the `#war-log` line, and advance the high-water mark. An error
 * closing one week stops that season's loop for this tick — weeks must close
 * in order — but does not stop any other season's.
 */
export async function weekTick(db: Database, opts: { now: Date; onError?: (seasonId: number, weekStart: Date, err: unknown) => void }): Promise<WeekTickResult> {
  const out: WeekTickResult = { closed: 0, errors: 0 };
  const openSeasons = await db.select({
    id: seasons.id, serverId: seasons.serverId, startedAt: seasons.startedAt, weekClosedThrough: seasons.weekClosedThrough,
  }).from(seasons).where(isNull(seasons.endedAt));

  for (const season of openSeasons) {
    let w = season.weekClosedThrough === null ? weekStartOf(season.startedAt) : nextWeek(season.weekClosedThrough);
    while (nextWeek(w) <= opts.now) {
      const thisWeek = w;
      try {
        let skipped = false;
        await db.transaction(async (tx) => {
          const [locked] = await tx.select({ weekClosedThrough: seasons.weekClosedThrough })
            .from(seasons).where(eq(seasons.id, season.id)).for("update");
          if (locked?.weekClosedThrough !== null && locked?.weekClosedThrough !== undefined && locked.weekClosedThrough.getTime() >= thisWeek.getTime()) {
            // Already closed by another instance or a replay of this tick.
            skipped = true;
            return;
          }
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
        });
        if (!skipped) out.closed++;
      } catch (err) {
        out.errors++;
        opts.onError?.(season.id, thisWeek, err);
        break; // weeks close in order — stop this season's loop for this tick
      }
      w = nextWeek(thisWeek);
    }
  }
  return out;
}
