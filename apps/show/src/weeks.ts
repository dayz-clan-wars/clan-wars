import { previousScoringWeek, scoringWeekEnd, scoringWeekStartOf } from "@factions/domain";

export const WEEK_MS = 7 * 24 * 3_600_000;

export type WeekWindow = { from: Date; to: Date };

/**
 * The half-open window `[weekStart, scoringWeekEnd(weekStart))`: seven days, except the bridging week that ends at the cutover.
 *
 * ⚠️ Refuses anything but a scoring week start (Monday 00:00 UTC before the cutover, Sunday 14:00 UTC after): every read in `src/story/` keys on
 * `raids.week_start`, which is exactly that instant, and a window that starts an hour
 * off would silently split a raid weekend across two episodes.
 */
export function weekWindow(weekStart: Date): WeekWindow {
  if (scoringWeekStartOf(weekStart).getTime() !== weekStart.getTime()) {
    throw new Error(`not a scoring week start: ${weekStart.toISOString()}`);
  }
  return { from: weekStart, to: scoringWeekEnd(weekStart) };
}

/** 1-based index of `weekStart` among the season's weeks (spec §2.4). */
export function episodeNumber(seasonStartedAt: Date, weekStart: Date): number {
  // Count calendar steps: weeks are not all seven days long across the cutover.
  let w = scoringWeekStartOf(seasonStartedAt);
  if (weekStart.getTime() < w.getTime()) throw new Error(`week ${weekStart.toISOString()} is before the season started`);
  let n = 1;
  while (scoringWeekEnd(w).getTime() <= weekStart.getTime()) { w = scoringWeekEnd(w); n++; }
  return n;
}

export function episodeCode(season: number, episode: number): string {
  return `S${String(season).padStart(2, "0")}E${String(episode).padStart(2, "0")}`;
}

/** `--week YYYY-MM-DD`, any day, resolved to the start of its scoring week. */
export function parseWeekArg(s: string): Date {
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(s)) throw new Error(`--week wants YYYY-MM-DD, got "${s}"`);
  const d = new Date(`${s}T00:00:00Z`);
  if (Number.isNaN(d.getTime())) throw new Error(`--week wants YYYY-MM-DD, got "${s}"`);
  return scoringWeekStartOf(d);
}

/** The start of the most recent scoring week that has fully ended by `now`. */
export function lastEndedWeek(now: Date): Date {
  return previousScoringWeek(scoringWeekStartOf(now));
}
