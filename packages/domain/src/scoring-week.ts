import { SCORING_WEEK_CUTOVER } from "./rules";
import { weekStartOf } from "./scoring";

const WEEK_MS = 7 * 24 * 3_600_000;
const SUNDAY = 0;

/**
 * The scoring week containing `d`. Before the cutover that is the old Monday 00:00 UTC week, so every week_start already stored keeps its key.
 * From the cutover on it is the latest Sunday 14:00 UTC at or before `d`, which is when the raid window closes.
 */
export function scoringWeekStartOf(d: Date): Date {
  if (d.getTime() < SCORING_WEEK_CUTOVER.getTime()) return weekStartOf(d);
  const sunday14 = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() - ((d.getUTCDay() - SUNDAY + 7) % 7), 14);
  return new Date(sunday14 > d.getTime() ? sunday14 - WEEK_MS : sunday14);
}

/** Where the week starting at `weekStart` ends. The bridging week is cut short at the cutover; ⚠️ a plain +7 d would skip past it. */
export function scoringWeekEnd(weekStart: Date): Date {
  const plain = weekStart.getTime() + WEEK_MS;
  if (weekStart.getTime() < SCORING_WEEK_CUTOVER.getTime()) return new Date(Math.min(plain, SCORING_WEEK_CUTOVER.getTime()));
  return new Date(plain);
}

/** The scoring week that ended where `weekStart` begins. */
export function previousScoringWeek(weekStart: Date): Date {
  return scoringWeekStartOf(new Date(weekStart.getTime() - 1));
}
