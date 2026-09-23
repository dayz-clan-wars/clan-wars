import { KD_MIN_KILLS } from "@factions/domain";
import { BOARD_LABELS, EMPTY_BOARD, NO_PROFILE, playTime, scopeLabel, boardValue } from "@factions/copy";

/**
 * Section headings for the ten boards, `EMPTY_BOARD`, `NO_PROFILE`,
 * `playTime` and `scopeLabel` all moved to `@factions/copy` (2026-09-13) once
 * the bot's `/player`, `/board` and `/achievements` needed the identical
 * wording; re-exported here so nothing on the site changes its import.
 */
export { BOARD_LABELS, EMPTY_BOARD, NO_PROFILE, playTime, scopeLabel, boardValue };

/** Under the streaks board: what ends one. */
export const STREAK_NOTE = "Ends on a PvP death";

/** Under the builders board: what a point is. */
export const BUILD_NOTE = "1 point per build step";

/** The K/D board's kill floor, spelled out under its table. */
export const KD_NOTE = `K/D needs ${KD_MIN_KILLS} kills`;

/** The panel's link to the board's own page, where every player is listed. */
export const SEE_ALL = "See all";
/** Page links on a full board. */
export const PAGER = { prev: "Previous", next: "Next", page: (n: number) => `Page ${n}` } as const;
