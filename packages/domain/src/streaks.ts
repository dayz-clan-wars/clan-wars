export type StreakRow = {
  killer: string | null; victim: string; friendlyFire: boolean; occurredAt: Date;
  /** A Hub kill (spec 2026-09-22-hub-combat): skipped on both sides, like friendly fire. */
  atHub?: boolean;
};

/**
 * One player's PvP streak from their own kill rows, ascending. Same rule as
 * packages/roster/src/stats.ts bestStreaks and killstreak-feed-tick.ts's
 * `runUpTo`: a non-friendly-fire kill of another player extends the run; a
 * non-friendly death to another player resets it; a non-player death does not.
 * A Hub kill (`atHub`) is skipped exactly as friendly fire is, on both sides.
 *
 * ⚠️ Friendly fire is skipped on BOTH sides (2026-09-21). Until then this reset
 * the run on a friendly death, which meant a clanmate could end a teammate's
 * `killing_spree`/`unstoppable` run on demand — the victim paying for someone
 * else's teamkill, on an achievement. Three implementations of this rule existed
 * and all three disagreed about the death half; they now agree.
 * `reachedAt(n)` is when the
 * run FIRST equalled n — the achievement's earned_at. `reachedIndex(n)` is the
 * index into `rows` of that same crossing kill: `reachedAt` alone is not a safe
 * key back into `rows` when two of the caller's own kills share one timestamp
 * (same-second log resolution), so a caller needing the actual row (for its id,
 * server, etc.) should index with this instead of re-finding by `occurredAt`.
 */
export function streakOf(rows: readonly StreakRow[], dayzId: string): { best: number; reachedAt: (n: number) => Date | null; reachedIndex: (n: number) => number | null } {
  let run = 0, best = 0;
  const firstAt = new Map<number, Date>();
  const firstIndex = new Map<number, number>();
  rows.forEach((r, i) => {
    if (r.killer === dayzId && r.victim !== dayzId && !r.friendlyFire && !r.atHub) {
      run += 1;
      if (!firstAt.has(run)) { firstAt.set(run, r.occurredAt); firstIndex.set(run, i); }
      if (run > best) best = run;
    } else if (r.victim === dayzId && r.killer !== null && r.killer !== dayzId && !r.friendlyFire && !r.atHub) {
      run = 0;
    }
  });
  return { best, reachedAt: (n) => firstAt.get(n) ?? null, reachedIndex: (n) => firstIndex.get(n) ?? null };
}
