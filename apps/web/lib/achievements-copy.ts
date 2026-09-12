import type { AchievementTile } from "@factions/roster";
import { ACHIEVEMENT_GROUP_COLORS, type AchievementGroup } from "@factions/domain";

/**
 * Every word the wall says. Thresholds come from the tile (i.e. from the
 * definitions in `@factions/domain`), never typed here — two statements of one
 * number would drift, and the wall would promise a target the tick never checks.
 */
export const GROUP_LABELS = { solo: "Solo", pve: "Survival", pvp: "Combat", team: "Clan" } as const;
/** The badge colour per group — the domain's, re-exported so every surface on the site reads it from here beside the labels. */
export const GROUP_COLORS: Record<AchievementGroup, string> = ACHIEVEMENT_GROUP_COLORS;
/** The unlock toast on the owner's own page (design hand-off §03). */
export const TOAST = { kicker: (group: AchievementGroup) => `Achievement unlocked · ${GROUP_LABELS[group]}`, windowDays: 7 } as const;
export const WALL = { title: "Achievements", locked: "Locked", closest: "Closest to unlocking", none: "Nothing in reach yet — play, and this fills in.", earnedOf: (n: number, of: number) => `${n} of ${of}` } as const;

/** ⚠️ UTC, like every other date the site prints: the server's timezone must not change what a player reads. */
const day = (d: Date) => d.toLocaleDateString("en-GB", { day: "numeric", month: "short", timeZone: "UTC" });

export function progressLine(t: AchievementTile): string | null {
  // A one-shot has nothing to count towards.
  if (t.target <= 1) return null;
  // ⚠️ point_blank's rule is "a kill from UNDER 5 m": its count is not monotone
  // towards its target, so any "best 0 m of 5 m" line reads as progress that is
  // not progress. A one-shot in practice.
  if (t.key === "point_blank") return null;
  switch (t.unit) {
    case "hours": return `${t.count} / ${t.target} h`;
    case "days": return `${t.count} / ${t.target} days`;
    case "m": return `best ${t.count} m of ${t.target} m`;
    default: return `${t.count} / ${t.target}`;
  }
}

export function earnedLine(t: AchievementTile): string | null {
  if (!t.earnedAt) return null;
  // A team tile is a clan's, earned with whichever clan the player stood in at the time.
  return `Earned ${day(t.earnedAt)}${t.group === "team" && t.clanTag ? ` with ${t.clanTag}` : ""}`;
}

/**
 * The unlocks the owner's page toasts: player-scoped, earned within the last
 * `TOAST.windowDays`, newest first, at most `limit`. There is no "last visit"
 * stamp to diff against, so recency stands in for it — a toast that never
 * went away would be a tile, not a toast.
 *
 * ⚠️ Player-scoped only. A team tile on a player's wall is the clan's unlock,
 * shared with everyone who stood in the clan; it is not the viewer's to be
 * congratulated for here.
 */
export type EarnedTile = AchievementTile & { earnedAt: Date };
export function freshUnlocks(tiles: readonly AchievementTile[], now: Date, limit = 3): EarnedTile[] {
  const since = now.getTime() - TOAST.windowDays * 86_400_000;
  return tiles
    .filter((t): t is EarnedTile => t.owner === "player" && t.earnedAt !== null && t.earnedAt.getTime() >= since && t.earnedAt.getTime() <= now.getTime())
    .sort((a, b) => b.earnedAt.getTime() - a.earnedAt.getTime())
    .slice(0, limit);
}
