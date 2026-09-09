import { KD_MIN_KILLS } from "@factions/domain";
import type { BoardKind, ResolvedScope } from "@factions/roster";

/** Section headings for the nine boards, in `BOARD_KINDS` order: raiding, offensive PvP, building, play time, then the shameful two. */
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

export const EMPTY_BOARD = "Nothing yet.";
export const NO_PROFILE = "No player by that name.";

/** `"12h 05m"` — hours and zero-padded minutes, unlike the bot's `duration()`. */
export function playTime(seconds: number): string {
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  return `${hours}h ${String(minutes).padStart(2, "0")}m`;
}

/** "All-time" or "Season N", for the scope picker and page headings. ⚠️ A RESOLVED scope: `Boards.scope` and `PlayerProfile.scope` never carry `"current"`. */
export function scopeLabel(scope: ResolvedScope): string {
  return scope.kind === "all" ? "All-time" : `Season ${scope.number}`;
}
