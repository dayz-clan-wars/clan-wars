import type { AchievementTile } from "@factions/roster";

/**
 * Every word the wall says. Thresholds come from the tile (i.e. from the
 * definitions in `@factions/domain`), never typed here — two statements of one
 * number would drift, and the wall would promise a target the tick never checks.
 */
export const GROUP_LABELS = { solo: "Solo", pve: "Survival", pvp: "Combat", team: "Clan" } as const;
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
