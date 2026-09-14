// Moved to `packages/copy/src/scoring.ts` on 2026-09-13 so the bot's embeds
// use the identical sentences instead of a second, drifting copy of them.
// Re-exported here so no page's import needs to change.
export { EMPTY_SCOREBOARD, NO_ALPHAS_WEEK, NO_SEASONS, EMPTY_WAR_LOG, ALPHA_BADGE } from "@factions/copy";

/**
 * `"3h 15m"`, hours and minutes, no seconds — the bot's rules
 * (`apps/bot/src/notice-text.ts`'s `duration`), re-implemented here because
 * `apps/web` cannot import the bot. Differs only in dropping a zero hours
 * part: under a minute reads `"0m"`, not `"0h 0m"`.
 */
export function duration(seconds: number): string {
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  return hours > 0 ? `${hours}h ${minutes}m` : `${minutes}m`;
}
