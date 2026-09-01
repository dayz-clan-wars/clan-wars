/** One file's filename time (server-local) against Nitrado's mtime (UTC). */
export type OffsetCandidate = { localTimestampMs: number; modifiedAtMs: number };

/**
 * Derive `clockOffsetMs` such that `UTC = server-local + offset`.
 *
 * Each file's mtime is at or after its creation instant, so every candidate
 * over-estimates by however long that file was still being written. The
 * MINIMUM is therefore the tightest available bound.
 *
 * ⚠️ Returns null, never 0, when nothing qualifies. A zero offset is invisible
 * to every count-based check in this system — every row lands, every
 * acceptance count matches, and only the absolute instants are hours wrong.
 * The caller must fall back to the stored offset instead.
 */
export function deriveClockOffsetMs(candidates: OffsetCandidate[]): number | null {
  if (candidates.length === 0) return null;
  let min = Infinity;
  for (const c of candidates) {
    const offset = c.modifiedAtMs - c.localTimestampMs;
    if (offset < min) min = offset;
  }
  return Number.isFinite(min) ? min : null;
}
