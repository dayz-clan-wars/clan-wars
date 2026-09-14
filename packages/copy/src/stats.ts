import type { BoardKind, ResolvedScope } from "@factions/roster";

/**
 * Player/board/achievement copy shared between the site and the bot.
 *
 * `BOARD_LABELS`, `EMPTY_BOARD`, `NO_PROFILE` and `playTime` moved from
 * `apps/web/lib/stats-copy.ts`, and `ACHIEVEMENT_CLOSEST`/`ACHIEVEMENT_NONE`
 * from `apps/web/lib/achievements-copy.ts` (2026-09-13), once the bot's
 * `/player`, `/board` and `/achievements` needed the identical wording — two
 * surfaces answering the same board name, empty state or unrecognised
 * gamertag in different words is exactly what this package exists to stop.
 * Both web files re-export these so no import elsewhere on the site changes.
 */
export const BOARD_LABELS: Record<BoardKind, string> = {
  raiders: "Top raiders",
  killers: "Top killers",
  kd: "Best K/D",
  streaks: "Best killstreak",
  longestKills: "Longest kill",
  builders: "Top builders",
  playTime: "Most play time",
  deaths: "Most PvP deaths",
  friendlyFire: "Most friendly fire",
};

/** A board page with no rows in the window — not a blank card. */
export const EMPTY_BOARD = "Nothing yet.";

/** The achievement wall's "closest to unlocking" panel, and its empty state. */
export const ACHIEVEMENT_CLOSEST = "Closest to unlocking";
export const ACHIEVEMENT_NONE = "Nothing in reach yet — play, and this fills in.";

/**
 * `playerProfile`/`achievementsFor` returning null — an unrecognised
 * gamertag. ONE sentence for ONE domain state: the site's `notFound()` page
 * (`apps/web/app/(site)/players/[gamertag]/not-found.tsx`) and the bot's
 * `/player`/`/achievements` all answer it. Neither surface echoes the name
 * back — the site's page body says only this, exactly as the bot's reply
 * does — so there is no "the URL already says it" difference to justify a
 * second sentence.
 */
export const NO_PROFILE = "No player by that name.";

/** `"12h 05m"` — hours and zero-padded minutes, unlike the bot's `hours()` (which rounds to whole hours and loses minutes). */
export function playTime(seconds: number): string {
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  return `${hours}h ${String(minutes).padStart(2, "0")}m`;
}

/**
 * "All-time" or "Season N", for the scope picker and page headings, and for
 * the bot's `/player` and `/board` cards. ⚠️ A RESOLVED scope: `Boards.scope`
 * and `PlayerProfile.scope` never carry `"current"`.
 *
 * Moved from `apps/web/lib/stats-copy.ts` (2026-09-13) once the bot's own
 * card needed the identical label — it had drifted to "All time" (missing
 * the hyphen) before this move, which is exactly the two-surfaces-one-fact
 * drift this package exists to stop.
 */
export function scopeLabel(scope: ResolvedScope): string {
  return scope.kind === "all" ? "All-time" : `Season ${scope.number}`;
}
