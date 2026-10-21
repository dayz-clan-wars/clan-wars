// The world layers: which toggles the layers panel offers for the static world data
// (lib/map-world.ts), and which points each one draws. Pure — no Leaflet, no DOM — so the
// selection is testable; map-draw.ts's `drawWorld` puts the result on the map.
import { EVENT_LAYERS, WORLD_GROUPS, WORLD_LABELS, type WorldGroup } from "./map-copy";
import { LOOT_GROUPS, effectiveUsage, type WorldFile } from "./map-world";
import { canHoldDeloot, canSpawnAt, type ItemIndexEntry } from "./item-index";
import type { WorldProto } from "./map-world";

export { EVENT_LAYERS };

/** e.g. "event:StaticWaterTruck", "loot:military", "bunkers", "contaminated", "spawns", "wrecks", "infected", "animals". */
export type WorldLayerKey = string;
export type WorldLayer = { key: WorldLayerKey; group: WorldGroup; label: string; defaultOn: boolean };

/** One point a layer draws. `tiers`/`usage` only on a loot building; `radius` (metres) only on an area drawn as a circle. */
export type WorldMark = { x: number; z: number; title: string; tiers?: string[]; usage?: string[]; radius?: number };
/** A point as drawn: `id` is stable across redraws, so the reconciler keeps a marker that is still wanted. */
export type WorldItem = WorldMark & { id: string; key: WorldLayerKey };

/** Its own key, apart from the clan layers' `clan-wars.map.layers`, so neither can clobber the other. */
export const WORLD_STORAGE_KEY = "clan-wars.map.world";

/**
 * Markers below this zoom are not drawn (bunkers and contaminated circles excepted). 4 is
 * where "Center on me" lands (RECENTRE_ZOOM) and where the travel points appear, so a
 * player who centres on themselves sees the vehicle and crash-site spawns around them.
 * Every event and spawn layer on at once is ~140 markers in a phone's padded view at 4.
 */
export const WORLD_MIN_ZOOM = 4;
/**
 * ⚠️ The loot buildings and wrecks wait one level more. They are 13.7k points, and with
 * every one of them on a padded phone view at zoom 4 holds ~2,700 — a DOM marker each.
 * At 5 it is under 1,000, and a player picking one or two loot types sees a few dozen.
 */
export const LOOT_MIN_ZOOM = 5;
/**
 * A searched item's points (itemItems): ITEM_KEY when there are few enough to draw at every
 * zoom, ITEM_MANY_KEY when there are more, which waits for LOOT_MIN_ZOOM like the loot buildings.
 */
export const ITEM_KEY = "item";
export const ITEM_MANY_KEY = "item:many";
/**
 * ⚠️ The most item points drawn zoomed out. M4A1 (40 zone buildings) fits, so a player sees
 * every spot at once; a Hammer is in over 6,000 buildings, and drawing those zoomed out is the
 * DOM-marker flood LOOT_MIN_ZOOM exists to stop.
 */
export const ITEM_ALWAYS_MAX = 250;
/** Drawn at every zoom: 23 bunkers and 21 circles cost nothing, and both are what a player scans the whole map for. */
export const ALWAYS_DRAWN: ReadonlySet<WorldLayerKey> = new Set(["bunkers", "contaminated", ITEM_KEY]);
/** The layers that wait for LOOT_MIN_ZOOM. */
export const isDense = (key: WorldLayerKey): boolean => key.startsWith("loot:") || key === "wrecks" || key === ITEM_MANY_KEY;

const WRECK = /^Land_wreck_/iu;
/** "wild_boar" → "Wild boar": a territory file's stem as an animal zone's title. */
const animalLabel = (kind: string): string => {
  const words = kind.replace(/_/gu, " ");
  return words.charAt(0).toUpperCase() + words.slice(1);
};

const bit = (list: string[], name: string) => {
  const i = list.indexOf(name);
  return i < 0 ? 0 : 1 << i;
};
const namesOf = (list: string[], mask: number) => list.filter((_, i) => (mask & (1 << i)) !== 0);
const lootMask = (w: WorldFile, usage: readonly string[]) => usage.reduce((m, n) => m | bit(w.limits.usage, n), 0);

/** The tiers the props actually carry, in limits order. Nasdara never sets Tier4, so it is never offered. */
export function presentTiers(w: WorldFile): { name: string; bit: number }[] {
  const all = allTiers(w);
  return w.limits.value.map((name, i) => ({ name, bit: 1 << i })).filter((t) => (all & t.bit) !== 0);
}

/** Every tier bit any prop carries: the tier filter's "everything" value. */
export function allTiers(w: WorldFile): number {
  let all = 0;
  for (const p of w.props) all |= p.t;
  return all;
}

/** The effective usage of prop `i`, or null when its type has no loot group (rocks, wrecks, fences). */
function propUsage(w: WorldFile, i: number): number | null {
  const prop = w.props[i]!;
  const proto = w.types[prop.type]?.proto;
  if (proto === null || proto === undefined) return null;
  return effectiveUsage(w.protos[proto]!, prop.u);
}

/**
 * Whether a prop passes the tier filter: any of its tier bits is picked.
 * ⚠️ t 0 always passes. Its areaflags cell carries no tier at all (8 Nasdara props), so no chip
 * can name it, and hiding it hid real loot buildings whatever the player picked.
 */
export const passesTier = (t: number, tiers: number): boolean => t === 0 || (t & tiers) !== 0;

function lootMark(w: WorldFile, i: number, usage: number, title: string): WorldMark {
  const p = w.props[i]!;
  return { x: p.x, z: p.z, title, tiers: namesOf(w.limits.value, p.t), usage: namesOf(w.limits.usage, usage) };
}

/**
 * The points one layer draws. `tiers` filters loot buildings only (passesTier: a building
 * shows when any of its tier bits is selected, or it has none); every other layer ignores it.
 */
export function pointsFor(w: WorldFile, key: WorldLayerKey, tiers: number): WorldMark[] {
  if (key === "bunkers") return w.bunkers.map((b, i) => ({ x: b.x, z: b.z, title: `Bunker ${i + 1}` }));
  if (key === "contaminated") return w.contaminated.map((a) => ({ x: a.x, z: a.z, title: "Contaminated area", radius: a.radius }));
  if (key === "spawns") return w.playerSpawns.map((s) => ({ x: s.x, z: s.z, title: "Player spawn" }));
  // The CE's territory zones (map-world.ts readTerritories), circles like the contaminated areas.
  if (key === "infected") return w.territories.infected.map((a) => ({ x: a.x, z: a.z, title: WORLD_LABELS.infected, radius: a.radius }));
  if (key === "animals") return w.territories.animals.map((a) => ({ x: a.x, z: a.z, title: animalLabel(a.kind), radius: a.radius }));
  if (key === "wrecks") {
    const out: WorldMark[] = [];
    for (const p of w.props) if (WRECK.test(w.types[p.type]?.name ?? "")) out.push({ x: p.x, z: p.z, title: "Wreck" });
    return out;
  }
  if (key.startsWith("event:")) {
    const name = key.slice("event:".length);
    const label = EVENT_LAYERS[name]?.label ?? name;
    return (w.events.find((e) => e.event === name)?.points ?? []).map((p) => ({ x: p.x, z: p.z, title: label }));
  }
  if (key.startsWith("loot:")) {
    const group = LOOT_GROUPS.find((g) => `loot:${g.key}` === key);
    if (!group) return [];
    const mask = lootMask(w, group.usage);
    const out: WorldMark[] = [];
    for (let i = 0; i < w.props.length; i++) {
      const usage = propUsage(w, i);
      if (usage === null || (usage & mask) === 0 || !passesTier(w.props[i]!.t, tiers)) continue;
      out.push(lootMark(w, i, usage, group.label));
    }
    return out;
  }
  return [];
}

/** The world layers this data supports, in panel order. Only layers with at least one point. Everything starts off but Bunkers. */
export function worldLayers(w: WorldFile): WorldLayer[] {
  const tiers = allTiers(w);
  const events = w.events.filter((e) => e.points.length > 0).map((e) => e.event);
  const known = Object.keys(EVENT_LAYERS);
  const unknown = events.filter((e) => !known.includes(e)).sort();
  const candidates: Omit<WorldLayer, "defaultOn">[] = [
    { key: "bunkers", group: "Bunkers", label: WORLD_LABELS.bunkers },
    ...known.filter((e) => events.includes(e)).map((e) => ({ key: `event:${e}`, group: EVENT_LAYERS[e]!.group, label: EVENT_LAYERS[e]!.label })),
    ...LOOT_GROUPS.map((g) => ({ key: `loot:${g.key}`, group: "Loot buildings" as const, label: g.label })),
    { key: "wrecks", group: "Wrecks", label: WORLD_LABELS.wrecks },
    { key: "infected", group: "World", label: WORLD_LABELS.infected },
    { key: "animals", group: "World", label: WORLD_LABELS.animals },
    ...unknown.map((e) => ({ key: `event:${e}`, group: "World" as const, label: e })),
    { key: "spawns", group: "World", label: WORLD_LABELS.spawns },
    { key: "contaminated", group: "World", label: WORLD_LABELS.contaminated },
  ];
  return candidates
    .filter((c) => pointsFor(w, c.key, tiers).length > 0)
    .map((c) => ({ ...c, defaultOn: c.key === "bunkers" }))
    // Stable sort into the headings' order; within a group the list above decides.
    .sort((a, b) => WORLD_GROUPS.indexOf(a.group) - WORLD_GROUPS.indexOf(b.group));
}

/**
 * Everything the switched-on layers draw, each with a stable id.
 *
 * ⚠️ A building can carry several usages (328 Nasdara protos do), so it can sit in more
 * than one loot layer. It is drawn ONCE, under the first switched-on group in
 * LOOT_GROUPS order — Military first, so a barracks that is also Town reads as
 * Military. Drawing it once per layer stacked two chips on one roof, and the one on
 * top was whichever layer happened to draw last.
 */
export function worldItems(w: WorldFile, on: ReadonlySet<WorldLayerKey>, tiers: number): WorldItem[] {
  const out: WorldItem[] = [];
  for (const key of on) {
    if (key.startsWith("loot:")) continue;
    pointsFor(w, key, tiers).forEach((m, i) => out.push({ ...m, id: `${key}#${i}`, key }));
  }
  const groups = LOOT_GROUPS.filter((g) => on.has(`loot:${g.key}`)).map((g) => ({ key: `loot:${g.key}`, label: g.label, mask: lootMask(w, g.usage) }));
  if (groups.length === 0) return out;
  for (let i = 0; i < w.props.length; i++) {
    if (!passesTier(w.props[i]!.t, tiers)) continue;
    const usage = propUsage(w, i);
    if (usage === null) continue;
    const g = groups.find((g) => (usage & g.mask) !== 0);
    if (g) out.push({ ...lootMark(w, i, usage, g.label), id: `prop#${i}`, key: g.key });
  }
  return out;
}

export type WorldSwitches = { on: Record<WorldLayerKey, boolean>; tiers: number };

/**
 * The saved switches, or each layer's default. Tiers are stored by NAME, not bit, so a
 * reordered limits file cannot turn a saved "Tier3" into a different tier.
 */
export function readWorldSwitches(raw: string | null, layers: WorldLayer[], w: WorldFile): WorldSwitches {
  const defaults = { on: Object.fromEntries(layers.map((l) => [l.key, l.defaultOn])), tiers: allTiers(w) };
  if (!raw) return defaults;
  try {
    const saved = JSON.parse(raw) as { on?: Record<string, unknown>; tiers?: unknown };
    const on = Object.fromEntries(layers.map((l) => [l.key, typeof saved.on?.[l.key] === "boolean" ? (saved.on[l.key] as boolean) : l.defaultOn]));
    const tiers = Array.isArray(saved.tiers)
      ? presentTiers(w).filter((t) => (saved.tiers as unknown[]).includes(t.name)).reduce((m, t) => m | t.bit, 0)
      : defaults.tiers;
    return { on, tiers };
  } catch {
    return defaults;
  }
}

export function writeWorldSwitches(on: Record<WorldLayerKey, boolean>, tiers: number, w: WorldFile): string {
  return JSON.stringify({ on, tiers: presentTiers(w).filter((t) => (tiers & t.bit) !== 0).map((t) => t.name) });
}

/** Protos by lower-cased name, once per world file: event children are matched to them by name. */
const protoIndex = new WeakMap<WorldFile, Map<string, WorldProto>>();
function protoNamed(w: WorldFile, name: string): WorldProto | undefined {
  let m = protoIndex.get(w);
  if (!m) {
    m = new Map();
    for (const p of w.protos) if (!m.has(p.name.toLowerCase())) m.set(p.name.toLowerCase(), p);
    protoIndex.set(w, m);
  }
  // ⚠️ Lower-cased, as linkProtos does: events.xml and mapgroupproto spell some wrecks differently.
  return m.get(name.toLowerCase());
}

/**
 * The events whose wrecks can hold this deloot item, in world.json order: an event counts when
 * any class it places has a loot group that passes canHoldDeloot. Read from the data, not a
 * list: the heli wrecks are MilitaryEast/West and the police cars Police, so each deloot item
 * lands only where its own usage sends it.
 */
export function delootEvents(w: WorldFile, item: ItemIndexEntry): string[] {
  if (!item.deloot || item.nominal <= 0) return [];
  return w.events
    .filter((e) => e.children?.some((c) => {
      const proto = protoNamed(w, c);
      return proto !== undefined && canHoldDeloot(item, proto);
    }))
    .map((e) => e.event);
}

/** An event's name for players: its layer label, else the raw name split at capitals ("InfectedArmy" → "Infected Army"). */
export const eventLabel = (event: string): string => EVENT_LAYERS[event]?.label ?? event.replace(/([a-z])([A-Z])/gu, "$1 $2");

/** The title on a building's point that holds the item fixed (a wheel on a wreck), not as loot. */
export const FIXED_SPOT = "Fixed spot";
const LOOT_SPOT = "Loot building";

/**
 * Every spot on the map this item can be found at: the buildings whose loot points can hold
 * it (canSpawnAt, with each prop's own area usage and tier), the placed buildings that carry
 * it fixed (a dispatch proxy), and the spawn points of the events that bring it (its own
 * events, and for deloot the events whose wrecks can hold it: delootEvents).
 *
 * ⚠️ No tier filter and no switches: a picked item is the whole question, and a tier chip
 * left off from earlier must not hide where it is. A building is one point however many
 * ways it qualifies.
 */
export function itemPoints(w: WorldFile, item: ItemIndexEntry): WorldMark[] {
  const out: WorldMark[] = [];
  const name = item.className.toLowerCase();
  // Only these two loops walk every prop; an item with neither source skips them.
  const loot = item.nominal > 0 && item.usage !== 0 && !item.deloot;
  if (loot || item.proxy) {
    for (let i = 0; i < w.props.length; i++) {
      const p = w.props[i]!;
      const index = w.types[p.type]?.proto;
      if (index === null || index === undefined) continue;
      const proto = w.protos[index]!;
      // ⚠️ Lower-cased: DayZ class names are case-insensitive, and mapgroupproto spells some differently from types.xml.
      if (item.proxy && proto.proxies?.some((x) => x.toLowerCase() === name)) {
        // No tier or loot line: a part fixed on a wreck is there whatever the area's loot.
        out.push({ x: p.x, z: p.z, title: FIXED_SPOT });
      } else if (loot && canSpawnAt(item, proto, p.u, p.t)) {
        out.push(lootMark(w, i, effectiveUsage(proto, p.u), LOOT_SPOT));
      }
    }
  }
  // Events whose wrecks carry it fixed: a placed building's proxies are drawn above, but a group
  // only an event places (the locked armory container's AKM) has no prop, only the event's spawns.
  const fixedIn = item.proxy
    ? w.events.filter((e) => e.children?.some((c) => protoNamed(w, c)?.proxies?.some((x) => x.toLowerCase() === name))).map((e) => e.event)
    : [];
  const events = new Set([...item.events, ...delootEvents(w, item), ...fixedIn]);
  for (const e of w.events) {
    if (!events.has(e.event)) continue;
    const title = eventLabel(e.event);
    for (const p of e.points) out.push({ x: p.x, z: p.z, title });
  }
  return out;
}

/**
 * A picked item's points as drawWorld takes them. ⚠️ The ids carry the class name: drawWorld
 * keeps a marker whose id and key it already has, so ids shared between two items would leave
 * the first item's markers standing after a second pick.
 */
export function itemItems(className: string, points: readonly WorldMark[]): WorldItem[] {
  const key = points.length <= ITEM_ALWAYS_MAX ? ITEM_KEY : ITEM_MANY_KEY;
  return points.map((m, i) => ({ ...m, id: `item:${className}#${i}`, key }));
}

/** A placed object's type name as a player reads it: "Land_Mil_Barracks1" → "Mil Barracks1". */
export const modelLabel = (typeName: string): string => typeName.replace(/^Land_/u, "").replace(/_/gu, " ");

/** Every placed type with how many times the map places it, for the search box's Models tab. */
export function modelCounts(w: WorldFile): { typeName: string; count: number }[] {
  const counts = new Array<number>(w.types.length).fill(0);
  for (const p of w.props) counts[p.type] = (counts[p.type] ?? 0) + 1;
  return w.types.flatMap((t, i) => (counts[i]! > 0 ? [{ typeName: t.name, count: counts[i]! }] : []));
}

/** Every placement of one type, titled with its label. Unknown type: none. */
export function modelPoints(w: WorldFile, typeName: string): WorldMark[] {
  const index = w.types.findIndex((t) => t.name === typeName);
  if (index < 0) return [];
  const title = modelLabel(typeName);
  return w.props.filter((p) => p.type === index).map((p) => ({ x: p.x, z: p.z, title }));
}

/**
 * A picked model's points as drawWorld takes them, on the item view's keys so the same group,
 * the same draw-at-every-zoom rule and the same Clear apply. ⚠️ The "model:" id prefix keeps a
 * model's markers apart from an item's: a model and an item can share a name, and drawWorld
 * keeps a marker whose id and key it already has.
 */
export function modelItems(typeName: string, points: readonly WorldMark[]): WorldItem[] {
  const key = points.length <= ITEM_ALWAYS_MAX ? ITEM_KEY : ITEM_MANY_KEY;
  return points.map((m, i) => ({ ...m, id: `model:${typeName}#${i}`, key }));
}
