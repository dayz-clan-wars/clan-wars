import { POINTS_BOTTOM, POINTS_TOP, POINTS_UNRANKED } from "./rules";

/**
 * Spec §8.1. `rank` is the victim's 1-based place among the ranked clans at
 * the moment of the lower, or null when the victim is unranked (active but no
 * points yet this season). `ranked` is how many clans were ranked.
 * Computed once, stored on the raid row, never recomputed.
 */
export function pointsFor(rank: number | null, ranked: number): number {
  if (rank === null) return POINTS_UNRANKED;
  if (ranked <= 1) return POINTS_TOP;
  const span = POINTS_TOP - POINTS_BOTTOM;
  return Math.round(POINTS_TOP - span * ((rank - 1) / (ranked - 1)));
}

/** Monday 00:00 UTC of the week containing `d` (spec §8.3). */
export function weekStartOf(d: Date): Date {
  const day = (d.getUTCDay() + 6) % 7; // Monday = 0
  const start = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() - day));
  return start;
}
