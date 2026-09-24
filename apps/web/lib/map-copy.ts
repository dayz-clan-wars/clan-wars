import { PIN_ICONS, PIN_NOTE_MAX } from "@factions/domain";

export { PIN_RESULT_COPY as RESULT_COPY, PIN_ICON_LABELS } from "@factions/copy";

/**
 * Everything the map's own furniture says that the bot never renders — layer
 * names, the layers-panel reasons, the first-time hint, and the age/expiry
 * formatters. Kept out of the client component so the copy is testable
 * without a DOM, and so the vocabulary test has one file to read.
 */

export const LAYER_LABELS = {
  you: "You", base: "Your base", clanmates: "Clanmates", intruders: "Intruders", bounties: "Bounties",
  publicBases: "Public bases", pins: "Pins", travel: "Travel points", places: "Place names", terrain: "Terrain",
} as const;

/** Why a switch is missing from the layers panel (App Review §03): what would put the layer there. */
export const LAYER_REASONS: Record<"base" | "clanmates" | "intruders" | "pins", string> = {
  base: "declare a base", clanmates: "join a clan", intruders: "declare a base", pins: "join a clan",
};

/** The one-time hint over a first map with nothing of the player's on it. */
export const MAP_HINT = {
  kicker: "Your map, so far",
  before: "This is you, last seen by the server. Raise a flag at a pole and ",
  cta: "declare it",
  after: " — the map then shows your base, its watch zone, and anyone who walks into it.",
  more: "In a clan you also see clanmates and shared pins.",
} as const;

/** The Leaflet container's accessible name: what it is, and how to move through it without a pointer. */
export const MAP_REGION_LABEL = "Map of Livonia. Tab moves between markers; Enter opens one.";

/** The "On the map" list in the layers panel and sheet. */
export const ROSTER_COPY = { heading: "On the map", empty: "Nothing of yours is on the map yet." } as const;

/** How to drop a pin: the legend's line, on both bars. */
export const PIN_HINT = "Press and hold, or use Pin here, to drop a pin.";
/** Under the pin sheet's grid ref while a "Pin here" draft follows the centre. */
export const PIN_FOLLOW = "Move the map to place it — the pin goes under the cross.";

/** The pin sheet's words. */
export const PIN_SHEET_COPY = {
  icon: "Icon",
  note: "Note",
  noteHint: `optional, ${PIN_NOTE_MAX} characters at most`,
  drop: "Drop a pin",
  cancel: "Cancel",
} as const;

/** What the map says about its own loading. */
export const MAP_LOAD_COPY = {
  loading: "Loading the map…",
  failedFirst: "The map could not load. It will try again in a moment.",
  retry: "Try again",
  stale: "The map could not be refreshed. What you see may be out of date.",
  refreshed: "Map refreshed.",
} as const;

/** "14 min ago", "3 h ago", "yesterday", "6 d ago" — the guide's own words for age. */
export function fixAge(at: Date, now: Date): string {
  const min = Math.round((now.getTime() - at.getTime()) / 60_000);
  if (min < 1) return "just now";
  if (min < 60) return `${min} min ago`;
  const h = Math.round(min / 60);
  if (h < 24) return `${h} h ago`;
  const d = Math.round(h / 24);
  return d === 1 ? "yesterday" : `${d} d ago`;
}

/** "expires in 6 d", "expires in 3 h", "expires in 20 min" — and "expiring" once the hour is up. */
export function expiresIn(expiresAt: Date, now: Date): string {
  const min = Math.round((expiresAt.getTime() - now.getTime()) / 60_000);
  if (min < 1) return "expiring";
  if (min < 60) return `expires in ${min} min`;
  const h = Math.round(min / 60);
  if (h < 24) return `expires in ${h} h`;
  return `expires in ${Math.round(h / 24)} d`;
}

/** Past 24 h a marker is dimmed (guide ch. 10). */
export const DIM_AFTER_MS = 24 * 3600_000;

export { PIN_ICONS };
