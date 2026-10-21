import { PIN_ICONS, PIN_NOTE_MAX } from "@factions/domain";
import type { LoadView } from "./map-load";

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

/**
 * The world layers' section headings, in panel order. Names follow iZurvive's,
 * so a player moving over finds things where they expect them.
 */
export const WORLD_GROUPS = ["Bunkers", "Vehicles", "Crash sites", "Loot buildings", "Wrecks", "World"] as const;
export type WorldGroup = (typeof WORLD_GROUPS)[number];

/**
 * What each cfgeventspawns event is called on the map, and where it sits. An
 * event missing here still gets a World toggle under its raw name, and
 * test/world-layers.test.ts lists the mission's events so a new one is noticed.
 * Order within a group is the panel's order.
 */
export const EVENT_LAYERS: Record<string, { group: WorldGroup; label: string }> = {
  StaticWaterTruck: { group: "Vehicles", label: "Water truck" },
  VehicleTruck01: { group: "Vehicles", label: "Truck" },
  VehicleCivilianSedan: { group: "Vehicles", label: "Olga" },
  VehicleHatchback02: { group: "Vehicles", label: "Gunter" },
  VehicleSedan02: { group: "Vehicles", label: "Sarka" },
  VehicleOffroadHatchback: { group: "Vehicles", label: "Ada" },
  VehicleOffroad02: { group: "Vehicles", label: "Hummer" },
  VehicleMotorbike: { group: "Vehicles", label: "Motorbike" },
  StaticHeliCrash: { group: "Crash sites", label: "Heli crash" },
  StaticHeliCrashBig: { group: "Crash sites", label: "Chinook crash" },
  StaticMilitaryConvoy: { group: "Crash sites", label: "Military convoy" },
  StaticPoliceCar: { group: "Crash sites", label: "Police car" },
  StaticContainerLocked: { group: "Crash sites", label: "Locked container" },
  ItemBricks: { group: "World", label: "Bricks" },
  TrajectoryFig: { group: "World", label: "Fig trees" },
  Loot: { group: "World", label: "Loot piles" },
};

/** The world layers that are not one event or one loot group. */
export const WORLD_LABELS = {
  bunkers: "Bunkers",
  wrecks: "Wrecks",
  infected: "Infected",
  animals: "Animals",
  spawns: "Player spawns",
  contaminated: "Contaminated areas",
} as const;

/** The world section's own lines in the layers panel. */
export const WORLD_COPY = {
  failed: "World layers could not load.",
  retry: "Try again",
  zoom: "Bunkers and contaminated areas show at every zoom. The rest show once you zoom in.",
  tiers: "Tiers",
} as const;

/** The search box (map-search.tsx). Tab names follow iZurvive's, like the world groups. */
export const SEARCH_COPY = {
  label: "Search the map",
  placeholder: "Place, item, bunker or GPS",
  tabs: { locations: "Locations", items: "Items", models: "Models" },
  bunker: "Bunker",
  goTo: "Go to",
  none: "Nothing on the map by that name.",
  pinIt: "Pin it",
} as const;

/**
 * The item view (item-panel.tsx, lib/item-view.ts): where a searched item can be found.
 * ⚠️ `none` is the one line a player acts on without checking, so lib/item-view.ts gives it
 * only when nothing at all places the item (item-index.ts spawnsAnywhere). An item that does
 * spawn, just not at a spot the map can draw (soda cans, crafted rags), gets `noSpot` instead.
 */
export const ITEM_COPY = {
  chip: (label: string) => `Showing where ${label} spawns`,
  // A searched building or object: every placement, not a spawn, so "where … spawns" would be wrong.
  modelChip: (label: string) => `Showing every ${label}`,
  placed: (n: number) => (n === 1 ? "1 placed." : `${n.toLocaleString("en-US")} placed.`),
  clear: "Clear",
  onMap: "On the map",
  spots: (n: number) => (n === 1 ? "1 spot." : `${n.toLocaleString("en-US")} spots.`),
  zoomIn: "Zoom in to see them.",
  where: "Where",
  noSpot: "Spawns, but not at a spot we can show on the map.",
  none: "Does not spawn on this server.",
  loading: "Loading items…",
  failed: "Items could not load. Try again.",
  howMany: "How many",
  upTo: (nominal: number) => `Up to ${nominal} on the server at once.`,
  restock: (min: number) => `More spawn when fewer than ${min} are left.`,
  foundIn: "Found in",
  tiers: "Tiers",
  anyTier: "Any tier",
  crashLabel: "Crash sites",
  // Only before world.json is in; after, the line names the events whose wrecks hold the item.
  crash: "Spawns in the wrecks at crash sites.",
  events: "Events",
  proxyLabel: "Fixed spots",
  proxy: "Sits fixed on some wrecks and buildings.",
  comesOn: "Comes on",
  more: (n: number) => ` and ${n} more`,
  spawnGearLabel: "Spawn gear",
  spawnGear: "Some fresh spawns start with it.",
  clanWarsLabel: "Clan Wars",
  clanWars: {
    "supply kit": "In the build supplies at a clan's flag.",
    "booster kit": "A booster kit pick.",
    award: "Given as an award.",
    "KotH loadout": "In a King of the Hill loadout.",
  },
} as const;

/** The item card (lib/item-cards.ts): what the item is, from the game's own files. */
export const CARD_COPY = {
  weight: "Weight",
  size: "Size",
  attachments: "Attachments",
  magazines: "Magazines",
  ammo: "Ammo",
} as const;

/** The ruler (map-ruler.tsx, lib/map-ruler.ts). */
export const RULER_COPY = {
  label: "Ruler",
  clear: "Clear",
  start: "Click or tap the map to start measuring.",
  next: "Click or tap to add the next point.",
} as const;

/** The readout (bottom bar): tap to copy. A refused clipboard says nothing. */
export const READOUT_COPY = { copy: "Copy", copied: "Copied" } as const;

/** "Tier1" → "Tier 1". "Unique" stays as it is. */
export function tierLabel(name: string): string {
  return name.replace(/^Tier(\d)$/u, "Tier $1");
}

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
export const MAP_REGION_LABEL = "Map of Nasdara. Tab moves between markers; Enter opens one.";

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

/** The legend, on both layouts. The age comes from DIM_AFTER_MS, so the words cannot drift from the dimming. */
export const MAP_LEGEND = `Last known, not live. A clanmate unseen for ${DIM_AFTER_MS / 3_600_000} h is dimmed and hollow.`;

/**
 * Why "Center on me" is off. In words on the page: a `title` never shows on a phone.
 * "Recently", not "since you linked": a fix older than POSITION_RETENTION_MS is
 * reaped, so a returning player with no fix HAS been logged since linking.
 */
export const NO_FIX = "No position for you yet — the server has not logged your character recently.";

/** A clan member's map with nobody on it says so, rather than looking broken. */
export function emptyLine(d: { clanmates: readonly unknown[] }, layers: { clanmates: boolean }): string | null {
  return layers.clanmates && d.clanmates.length === 0 ? "No clanmates on the map yet — one appears once the server logs them." : null;
}

/**
 * The standing-fact lines, gated on the map actually being up. `data` can
 * arrive before `mapReady` does — the JSON fetch and the Leaflet chunk load
 * in parallel on mount — so computing these from `data` alone let them paint
 * over MapStatus's "loading"/"failed-first" overlay, which is supposed to own
 * those states exclusively. "stale" still shows lines: the map IS on screen
 * then, just possibly out of date.
 */
export function infoLines(
  view: LoadView,
  d: { clanmates: readonly unknown[]; you: { fix: unknown } } | null | undefined,
  layers: { clanmates: boolean },
): string[] {
  if (!d || (view !== "ready" && view !== "stale")) return [];
  return [emptyLine(d, layers), d.you.fix ? null : NO_FIX].filter((s): s is string => s !== null);
}

export { PIN_ICONS };
