/**
 * Scoring copy — the score board, alphas, seasons and war-log's outcome
 * sentences. Moved from `apps/web/lib/scoring-copy.ts` (2026-09-13) once the
 * bot needed the identical sentences: two surfaces answering the same empty
 * state in different words is exactly what this package exists to stop.
 * `apps/web/lib/scoring-copy.ts` re-exports these so no page's import changes.
 */
export const EMPTY_SCOREBOARD = "No season is open. The scoreboard starts with the first raid after the season opens.";
export const NO_ALPHAS_WEEK = "Nobody scored.";
export const NO_SEASONS = "No season has closed yet.";
export const EMPTY_WAR_LOG = "No raids yet this season.";
export const ALPHA_BADGE = "Alpha";
