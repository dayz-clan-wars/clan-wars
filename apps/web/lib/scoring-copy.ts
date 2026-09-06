export const EMPTY_SCOREBOARD = "No season is open. The scoreboard starts with the first raid after the season opens.";
export const NO_ALPHAS_WEEK = "Nobody scored.";
export const NO_SEASONS = "No season has closed yet.";
export const EMPTY_WAR_LOG = "No raids yet this season.";
export const ALPHA_BADGE = "Alpha";

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
