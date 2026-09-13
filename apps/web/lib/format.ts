// `days`/`hours`/`when` moved to @factions/copy so the bot reads the same
// clocks the site does; re-exported here so this file's own consumers
// (and everything importing "./format") do not change.
export { days, hours, when } from "@factions/copy";

/**
 * `ago` is for an observation — seen, asked, joined, rotated, raised —
 * relative under a day and a bare date after, because "3 h ago" is what a
 * player wants and the UTC suffix on every row was noise. Site-only: the
 * bot has no equivalent "ago" surface today.
 */
export function ago(d: Date, now: Date = new Date()): string {
  const min = Math.round((now.getTime() - d.getTime()) / 60_000);
  if (min < 1) return "just now";
  if (min < 60) return `${min} min ago`;
  const h = Math.round(min / 60);
  if (h < 24) return `${h} h ago`;
  return d.toLocaleDateString("en-GB", { day: "numeric", month: "short", timeZone: "UTC" });
}
