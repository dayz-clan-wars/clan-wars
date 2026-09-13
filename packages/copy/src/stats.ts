import type { BoardKind } from "@factions/roster";

/**
 * Player/board/achievement copy shared between the site and the bot.
 *
 * `BOARD_LABELS` and `EMPTY_BOARD` moved from `apps/web/lib/stats-copy.ts`,
 * and `ACHIEVEMENT_CLOSEST`/`ACHIEVEMENT_NONE` from
 * `apps/web/lib/achievements-copy.ts` (2026-09-13), once `/board` and
 * `/achievements` needed the identical wording — two surfaces answering the
 * same board name or empty state in different words is exactly what this
 * package exists to stop. Both web files re-export these so no import
 * elsewhere on the site changes.
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
 * `/player` and `/achievements` (no `clan:`) answer the same outcome — an
 * unrecognised gamertag — and must agree with each other, so it lives here
 * rather than being written twice in `apps/bot/src/commands/stats.ts`.
 *
 * ⚠️ This is NOT the same sentence as the site's `NO_PROFILE`
 * (`apps/web/lib/stats-copy.ts`, "No player by that name."): that string
 * backs a formal Next.js `notFound()` page, where the URL itself already
 * says which name was looked up. In a chat reply there is no URL and no
 * page chrome, so the sentence names the search space explicitly instead —
 * genuinely new wording, not a fork of the site's.
 */
export const NO_SUCH_PLAYER = "No player by that name has been seen on the server.";
