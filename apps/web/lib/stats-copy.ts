import { KD_MIN_KILLS } from "@factions/domain";
import type { Boards, ResolvedScope } from "@factions/roster";

/** Section headings for the six boards (spec §11, plus deaths), in display order. */
export const BOARD_LABELS: Record<keyof Omit<Boards, "scope" | "seasons">, string> = {
  raiders: "Top raiders",
  killers: "Top killers",
  deaths: "Most PvP deaths",
  kd: "Best K/D",
  playTime: "Most play time",
  friendlyFire: "Most friendly fire",
};

/** The K/D board's kill floor, spelled out under its table. */
export const KD_NOTE = `K/D needs ${KD_MIN_KILLS} kills`;

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
