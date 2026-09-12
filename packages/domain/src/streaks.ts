export type StreakRow = { killer: string | null; victim: string; friendlyFire: boolean; occurredAt: Date };

/**
 * One player's PvP streak from their own kill rows, ascending. Same rule as
 * packages/roster/src/stats.ts bestStreaks: a non-friendly-fire kill of
 * another player extends the run; any death to another player (friendly fire
 * included) resets it; a non-player death does not. `reachedAt(n)` is when the
 * run FIRST equalled n — the achievement's earned_at.
 */
export function streakOf(rows: readonly StreakRow[], dayzId: string): { best: number; reachedAt: (n: number) => Date | null } {
  let run = 0, best = 0;
  const firstAt = new Map<number, Date>();
  for (const r of rows) {
    if (r.killer === dayzId && r.victim !== dayzId && !r.friendlyFire) {
      run += 1;
      if (!firstAt.has(run)) firstAt.set(run, r.occurredAt);
      if (run > best) best = run;
    } else if (r.victim === dayzId && r.killer !== null && r.killer !== dayzId) {
      run = 0;
    }
  }
  return { best, reachedAt: (n) => firstAt.get(n) ?? null };
}
