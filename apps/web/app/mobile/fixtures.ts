/**
 * Demo data for the mobile shell at /mobile.
 *
 * ⚠️ Every value here is INVENTED. Nothing in this file came from the game
 * server, and nothing in this route may ever read the real thing — the site is
 * a surface, never a source of truth, and `apps/web/test/smoke.test.ts` is what
 * holds that line now that the live database sits one loopback port away. The
 * screens exist so the shape of the product can be argued about before the read
 * model behind it is designed; see
 * `docs/direction/2026-09-02-web-app-and-faction-map.md`, which is direction,
 * not an approved spec.
 *
 * Ported from the `Clan Wars Mobile.dc.html` design-canvas screen, whose own
 * script block held these same constants.
 */

/** Livonia is 12.8km on a side. Marker percentages are taken against this. */
export const MAP_METRES = 12800;

/**
 * ⚠️ No Livonia terrain render is committed to this repo, and the design left
 * its map as an empty drop-slot. Null renders the placeholder plate instead of
 * a broken image; point it at a file under `public/` to light the map up.
 *
 * The plate deliberately does not imitate terrain — a fake coastline behind
 * real marker coordinates would read as a working map.
 */
export const LIVONIA_MAP_SRC: string | null = null;

export type Member = {
  gamertag: string;
  /** Nearest named settlement. The fix itself is never printed as coordinates. */
  near: string;
  x: number;
  y: number;
  online: boolean;
  /** Age of the last position fix, already humanised. */
  fix: string;
};

export const MEMBERS: readonly Member[] = [
  { gamertag: "SubatomicRacer", near: "Topolin", x: 3120, y: 9040, online: true, fix: "Just now" },
  { gamertag: "Kestrel_44", near: "Sitnik", x: 5980, y: 7420, online: true, fix: "4m ago" },
  { gamertag: "OldManRiver", near: "Nadbor", x: 7640, y: 4880, online: true, fix: "9m ago" },
  { gamertag: "vex.", near: "Brena", x: 2280, y: 5160, online: false, fix: "3h ago" },
  { gamertag: "HARROW", near: "Gliniska", x: 9200, y: 10420, online: false, fix: "1d ago" },
];

export const BASE = { x: 3040, y: 9180 };

export type RosterEntry = { gamertag: string; role: string };

export const ROSTER: readonly RosterEntry[] = [
  { gamertag: "SubatomicRacer", role: "Leader" },
  { gamertag: "Kestrel_44", role: "Officer" },
  { gamertag: "OldManRiver", role: "Officer" },
  { gamertag: "vex.", role: "Member" },
  { gamertag: "HARROW", role: "Member" },
];

export type FeedScope = "server" | "mine";

export type FeedItem = {
  kind: string;
  color: string;
  flag: string;
  scope: FeedScope;
  text: string;
  time: string;
};

export const FEED: readonly FeedItem[] = [
  {
    kind: "Raid", color: "#8C3A22", flag: "Flag_Wolf", scope: "server",
    text: "⚔️ Wolf Tang Clan raided The Nest — flag lowered by SubatomicRacer",
    time: "Sun 03:12",
  },
  {
    kind: "Defense", color: "#8FA36A", flag: "Flag_Snake", scope: "server",
    text: "🛡️ Vipers Rest raised their colors again — 4h under siege",
    time: "Sun 01:40",
  },
  {
    kind: "Raid", color: "#8C3A22", flag: "Flag_Bear", scope: "server",
    text: "⚔️ Kamensk Bears raided Gliniska Union — flag lowered by HARROW",
    time: "Sat 22:05",
  },
  {
    kind: "Founded", color: "#D9A03C", flag: "Flag_Rooster", scope: "server",
    text: "Red Rooster founded at a pole near Brena — 4 on the founding roster",
    time: "Sat 18:22",
  },
  {
    kind: "Dormant", color: "#8A857C", flag: "Flag_Crook", scope: "server",
    text: "Crooked Nine went dormant — no roster activity for 7 days",
    time: "Fri 09:00",
  },
  {
    kind: "Moved", color: "#D9A03C", flag: "Flag_Wolf", scope: "mine",
    text: "Wolf Tang Clan moved its base — old pole stays private for 3 days",
    time: "Thu 20:14",
  },
  {
    kind: "Joined", color: "#D9A03C", flag: "Flag_Wolf", scope: "mine",
    text: "HARROW joined the roster",
    time: "Wed 17:02",
  },
];

/** Textures shown as already held in the claim grid. */
export const HELD: readonly string[] = [
  "Flag_Wolf", "Flag_Snake", "Flag_Bear", "Flag_Rooster", "Flag_Crook", "Flag_CDF",
];

/** A 16-flag slice of the 33 claimable textures — the grid is a sample, not the pool. */
export const POOL: readonly string[] = [
  "Flag_Wolf", "Flag_Snake", "Flag_Bear", "Flag_Rooster",
  "Flag_Pirates", "Flag_Cannibals", "Flag_HunterZ", "Flag_BrainZ",
  "Flag_Zenit", "Flag_Chedaki", "Flag_NAPA", "Flag_Refuge",
  "Flag_Rex", "Flag_Crook", "Flag_CDF", "Flag_TEC",
];

export type DirectoryEntry = { name: string; tag: string; flag: string; meta: string };

export const DIRECTORY: readonly DirectoryEntry[] = [
  { name: "Wolf Tang Clan", tag: "WTC", flag: "Flag_Wolf", meta: "5 members · Active" },
  { name: "Vipers Rest", tag: "VPR", flag: "Flag_Snake", meta: "7 members · Active" },
  { name: "Kamensk Bears", tag: "BEAR", flag: "Flag_Bear", meta: "6 members · Active" },
  { name: "Red Rooster", tag: "ROO", flag: "Flag_Rooster", meta: "4 members · Active" },
  { name: "Gliniska Union", tag: "GU", flag: "Flag_CDF", meta: "3 members · Active" },
  { name: "Crooked Nine", tag: "IX", flag: "Flag_Crook", meta: "5 members · Dormant" },
];

export type Invite = { name: string; flag: string; meta: string; expires: string };

export const INVITES: readonly Invite[] = [
  { name: "Vipers Rest", flag: "Flag_Snake", meta: "7 members · invited by Ospr3y", expires: "in 6 days" },
  { name: "Red Rooster", flag: "Flag_Rooster", meta: "4 members · invited by mudlark", expires: "in 2 days" },
];

/**
 * ⚠️ Flag images are served from `public/flags/` under OUR texture name, never
 * the wiki's — `apps/web/src/flag-images.ts` is where that translation stops.
 * A name with no file behind it fails as a blank tile, not as an error.
 */
export function flagUrl(texture: string): string {
  return `/flags/${texture}.png`;
}
