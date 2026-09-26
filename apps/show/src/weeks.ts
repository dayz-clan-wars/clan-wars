import { weekStartOf } from "@factions/domain";

export const WEEK_MS = 7 * 24 * 3_600_000;

export type WeekWindow = { from: Date; to: Date };

/**
 * The half-open window `[weekStart, weekStart + 7 d)`.
 *
 * ⚠️ Refuses anything but a Monday 00:00 UTC: every read in `src/story/` keys on
 * `raids.week_start`, which is exactly that instant, and a window that starts an hour
 * off would silently split a raid weekend across two episodes.
 */
export function weekWindow(weekStart: Date): WeekWindow {
  if (weekStartOf(weekStart).getTime() !== weekStart.getTime()) {
    throw new Error(`not a Monday 00:00 UTC week start: ${weekStart.toISOString()}`);
  }
  return { from: weekStart, to: new Date(weekStart.getTime() + WEEK_MS) };
}

/** 1-based index of `weekStart` among the season's weeks (spec §2.4). */
export function episodeNumber(seasonStartedAt: Date, weekStart: Date): number {
  const first = weekStartOf(seasonStartedAt);
  const n = Math.round((weekStart.getTime() - first.getTime()) / WEEK_MS) + 1;
  if (n < 1) throw new Error(`week ${weekStart.toISOString()} is before the season started`);
  return n;
}

export function episodeCode(season: number, episode: number): string {
  return `S${String(season).padStart(2, "0")}E${String(episode).padStart(2, "0")}`;
}

/** `--week YYYY-MM-DD`, any day of the week, resolved to that week's Monday. */
export function parseWeekArg(s: string): Date {
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(s)) throw new Error(`--week wants YYYY-MM-DD, got "${s}"`);
  const d = new Date(`${s}T00:00:00Z`);
  if (Number.isNaN(d.getTime())) throw new Error(`--week wants YYYY-MM-DD, got "${s}"`);
  return weekStartOf(d);
}

/** The Monday of the most recent week that has fully ended by `now`. */
export function lastEndedWeek(now: Date): Date {
  return new Date(weekStartOf(now).getTime() - WEEK_MS);
}
