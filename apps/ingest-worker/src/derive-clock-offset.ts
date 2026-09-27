/** One file's filename time (server-local) against Nitrado's mtime (UTC). */
export type OffsetCandidate = { localTimestampMs: number; modifiedAtMs: number };

/** Real timezone offsets are whole multiples of 15 minutes. */
const GRID_MS = 900_000;

/**
 * How far BELOW the true offset a candidate may read and still snap to it.
 *
 * ⚠️ Without it a bare floor is wrong in the commonest case. A file the server
 * created and never wrote to again has zero write-lag, so its candidate sits
 * EXACTLY on the grid; the filename comes from the game server's clock and the
 * mtime from Nitrado's, and one second of disagreement between them floored
 * Livonia to 6h45m on 2026-09-26. Retention (tick.ts) only ever lowers the
 * stored value, so that one reading stood for a day and a half — every event
 * stamped 15 minutes early, and a King of the Hill scored over the wrong window.
 *
 * The cost is at the other end: a smallest lag between `GRID_MS - TOLERANCE_MS`
 * and `GRID_MS` now derives one step HIGH. Retention discards a high reading, so
 * that edge costs nothing; a low one is permanent, so this is the side to pad.
 */
const TOLERANCE_MS = 5 * 60_000;

/**
 * Derive `clockOffsetMs` such that `UTC = server-local + offset`.
 *
 * Each file's mtime is at or after its creation instant, so every candidate
 * over-estimates by however long that file was still being written. The
 * MINIMUM is therefore the tightest available bound.
 *
 * The minimum, plus `TOLERANCE_MS`, is then snapped DOWN to the 15-minute grid.
 * Every candidate is `trueOffset + writeLag` with `writeLag >= 0` in principle
 * (but see `TOLERANCE_MS` — the two clocks disagree), so the minimum is
 * `trueOffset + smallestLag`. Every real timezone offset is a whole number of
 * 15-minute units, so `Math.floor((min + TOLERANCE_MS) / 900_000) * 900_000`
 * recovers `trueOffset` EXACTLY whenever the smallest listed write-lag lies in
 * [-5 min, 10 min) — which removes the estimate's dependence on which files
 * Nitrado happens to be listing this tick. Without it the derived value drifts
 * upward over a session and the same ADM file's lines get stamped hours apart.
 *
 * `Math.floor` is correct for negative offsets too: it floors toward negative
 * infinity, which still lands on a grid point at or below the estimate. For a
 * true offset of -4h and a 43s lag, `min + TOLERANCE_MS = -14_057_000`,
 * `/ 900_000 = -15.62…`, `Math.floor` gives -16, and `-16 * 900_000 =
 * -14_400_000` — exactly -4h.
 *
 * ⚠️ Returns null, never 0, when nothing qualifies. A zero offset is invisible
 * to every count-based check in this system — every row lands, every
 * acceptance count matches, and only the absolute instants are hours wrong.
 * The caller must fall back to the stored offset instead.
 *
 * ⚠️ CALLER OBLIGATION: Candidates must be pre-filtered to those with a real
 * mtime (`modifiedAtMs > 0`) and a parseable local timestamp. A zero mtime wins
 * the minimum and produces a hugely negative offset, shifting every ingested
 * timestamp by decades. The upstream API client reports a missing mtime faithfully
 * as 0; only the caller knows which candidates are real and which are missing.
 */
export function deriveClockOffsetMs(candidates: OffsetCandidate[]): number | null {
  if (candidates.length === 0) return null;
  let min = Infinity;
  for (const c of candidates) {
    const offset = c.modifiedAtMs - c.localTimestampMs;
    if (offset < min) min = offset;
  }
  if (!Number.isFinite(min)) return null;
  return Math.floor((min + TOLERANCE_MS) / GRID_MS) * GRID_MS;
}
