// The static world data the map layers draw from: event spawns, bunkers, contaminated zones,
// infected and animal territories, fresh-spawn points and the mission's building props. Built by hand from the Nasdara mission
// checkout (scripts/build-map-world.ts) and committed, so the web never reads the mission.
//
// Coordinates are DayZ world metres: x east, z north, 0..WORLD_SIZE_M. The y (height) the
// mission files carry is dropped here — the map is flat.
import { XMLParser } from "fast-xml-parser";
import { WORLD_MAP } from "@factions/domain";
import type { parseLimits } from "./area-flags";

export type WorldPoint = { x: number; z: number };
// cfgeventspawns name. `children`: the classes the event places when it is active (events.xml
// <children> and its positions' cfgeventgroups groups, item-index.ts eventChildren), sorted;
// absent for an inactive event or one with none. The item search reads it for deloot.
export type WorldEvent = { event: string; points: WorldPoint[]; children?: string[] };
export type WorldArea = { name: string; x: number; z: number; radius: number };
/** One env/*_territories.xml <zone>: a circle the CE spawns infected or animals in. */
export type WorldZone = { x: number; z: number; radius: number };
/** `kind`: the territory file's stem ("wild_boar" from env/wild_boar_territories.xml), for the popup title. */
export type WorldTerritories = { infected: WorldZone[]; animals: (WorldZone & { kind: string })[] };
// u / t: the areaflags.map usage and value (tier) bitmasks at the prop's position; bit k is
// entry k of WorldFile.limits.usage / .value.
export type WorldProp = { type: number; x: number; z: number; u: number; t: number };
export type WorldType = { name: string; proto: number | null };
export type WorldProto = {
  name: string;
  usage: number; // group <usage> mask, 0 = none; the area flags apply on top either way (effectiveUsage)
  containers: { categories: number; tags: number; points: number }[]; // masks over limits.categories / limits.tags
  // Item classes fixed on the building by <dispatch><proxy type> (a car wreck's doors and
  // wheels), sorted and unique. Absent when it has none, which is nearly every building.
  proxies?: string[];
};

export type WorldFile = {
  version: 1;
  limits: ReturnType<typeof parseLimits>; // cfglimitsdefinition.xml lists, in bit order
  source: { commit: string; builtAt: string };
  events: WorldEvent[]; // only events with ≥1 position
  bunkers: WorldPoint[]; // cfgbunkerbroadcast.json proxies[].position [x,y,z] → {x, z}
  contaminated: WorldArea[]; // cfgEffectArea.json Areas[].Data.Pos/Radius
  territories: WorldTerritories; // the env/*_territories.xml files cfgenvironment.xml lists (readTerritories)
  playerSpawns: WorldPoint[]; // cfgplayerspawnpoints.xml <fresh> positions
  props: WorldProp[]; // mapgrouppos rows; `type` indexes `types`
  types: WorldType[]; // proto indexes `protos`, null = no loot group
  protos: WorldProto[]; // mapgroupproto.xml groups
};

// isArray forces a list for chosen tags: fast-xml-parser returns a lone child as an object,
// so an event with exactly one <pos> would otherwise parse as a different shape than one with two.
// ⚠️ isArray also fires for ATTRIBUTES: forcing "pos" would turn mapgrouppos's pos="x y z"
// string into an array, so each parser names only the tags it needs.
const xml = (...arrays: string[]) =>
  new XMLParser({
    ignoreAttributes: false,
    attributeNamePrefix: "",
    isArray: (name) => arrays.includes(name),
  });

const num = (v: unknown): number => Number(v);

type Pos = { x: string; z: string };
const toPoints = (pos: Pos[] | undefined): WorldPoint[] =>
  (pos ?? []).map((p) => ({ x: num(p.x), z: num(p.z) }));

export function parseEventSpawns(text: string): WorldEvent[] {
  const doc = xml("event", "pos").parse(text) as { eventposdef?: { event?: { name: string; pos?: Pos[] }[] } };
  return (doc.eventposdef?.event ?? [])
    .map((e) => ({ event: e.name, points: toPoints(e.pos) }))
    .filter((e) => e.points.length > 0);
}

export function parseBunkers(text: string): WorldPoint[] {
  const doc = JSON.parse(text) as { proxies?: { position: [number, number, number] }[] };
  return (doc.proxies ?? []).map((p) => ({ x: p.position[0], z: p.position[2] }));
}

export function parseEffectAreas(text: string): WorldArea[] {
  const doc = JSON.parse(text) as {
    Areas?: { AreaName: string; Data: { Pos: [number, number, number]; Radius: number } }[];
  };
  return (doc.Areas ?? []).map((a) => ({
    name: a.AreaName,
    x: a.Data.Pos[0],
    z: a.Data.Pos[2],
    radius: a.Data.Radius,
  }));
}

/** The territory files cfgenvironment.xml loads: its <territories><file path>, in order. */
export function parseEnvironmentFiles(text: string): string[] {
  const doc = xml("file").parse(text) as { env?: { territories?: { file?: { path?: string }[] } } };
  // <territory><file usable> inside the same block names a file by stem, not path: skipped here.
  return (doc.env?.territories?.file ?? []).flatMap((f) => (f.path ? [f.path] : []));
}

/** Every <zone> of every <territory> in one env/*_territories.xml, as a circle. */
export function parseTerritoryZones(text: string): WorldZone[] {
  type Zone = { x: string; z: string; r: string };
  // An empty file is <territory-type/>, which parses as "" rather than an object.
  const doc = xml("territory", "zone").parse(text) as { "territory-type"?: { territory?: { zone?: Zone[] }[] } | "" };
  const root = doc["territory-type"];
  if (!root) return [];
  return (root.territory ?? []).flatMap((t) => (t.zone ?? []).map((z) => ({ x: num(z.x), z: num(z.z), radius: num(z.r) })));
}

const ZOMBIE_FILE = /(^|\/)zombie_territories\.xml$/iu;

/**
 * The infected and animal territories, from the files cfgenvironment.xml lists. `read` returns a
 * file's text by its mission-relative path, or null when the file is not there.
 *
 * ⚠️ The list decides, not the env folder. Nasdara's env/ holds bear, wolf and deer files that
 * cfgenvironment.xml never names (so the game never loads them), and names sheep, fox and others
 * that are not on disk. Drawing the folder would put animals where none spawn. A listed file that
 * is missing comes back in `missing` for the build to print.
 */
export function readTerritories(environment: string, read: (path: string) => string | null): { territories: WorldTerritories; missing: string[] } {
  const territories: WorldTerritories = { infected: [], animals: [] };
  const missing: string[] = [];
  for (const path of parseEnvironmentFiles(environment)) {
    const text = read(path);
    if (text === null) {
      missing.push(path);
      continue;
    }
    const zones = parseTerritoryZones(text);
    if (ZOMBIE_FILE.test(path)) territories.infected.push(...zones);
    else {
      const kind = path.replace(/^.*\//u, "").replace(/_territories\.xml$/iu, "");
      territories.animals.push(...zones.map((z) => ({ ...z, kind })));
    }
  }
  return { territories, missing };
}

export function parsePlayerSpawns(text: string): WorldPoint[] {
  // ⚠️ <fresh> only: <hop> and <travel> hold the same shape, and mixing them in would draw
  // spawn points a brand-new character can never get.
  type Bubbles = { group?: { pos?: Pos[] }[]; pos?: Pos[] };
  const doc = xml("group", "pos").parse(text) as {
    playerspawnpoints?: { fresh?: { generator_posbubbles?: Bubbles } };
  };
  const bubbles = doc.playerspawnpoints?.fresh?.generator_posbubbles;
  if (!bubbles) return [];
  return [...toPoints(bubbles.pos), ...(bubbles.group ?? []).flatMap((g) => toPoints(g.pos))];
}

export function parseGroupPositions(text: string): { name: string; x: number; z: number }[] {
  const doc = xml("group").parse(text) as { map?: { group?: { name: string; pos: string }[] } };
  return (doc.map?.group ?? []).map((g) => {
    // pos="x y z": the middle value is height.
    const [x, , z] = g.pos.trim().split(/\s+/).map(Number);
    return { name: g.name, x: x!, z: z! };
  });
}

type Named = { name: string };
type ProtoXml = {
  name: string;
  usage?: Named[];
  dispatch?: { proxy?: { type: string }[] }[];
  container?: { category?: Named[]; tag?: Named[]; point?: unknown[] }[];
};

/** mapgroupproto.xml groups. Names resolve to bits via `limits`; an unknown name throws. */
export function parseProtos(text: string, limits: ReturnType<typeof parseLimits>): WorldProto[] {
  const doc = xml("group", "container", "usage", "category", "tag", "point", "dispatch", "proxy").parse(text) as {
    prototype?: { group?: ProtoXml[] };
  };
  // ⚠️ Throwing on an unknown name (not skipping it) is deliberate: a dropped bit would silently
  // move a building into the wrong loot layer after a limits file change.
  const mask = (list: string[], names: Named[] | undefined, what: string) =>
    (names ?? []).reduce((m, n) => {
      const i = list.indexOf(n.name);
      if (i < 0) throw new Error(`mapgroupproto: ${what} "${n.name}" is not in cfglimitsdefinition.xml`);
      return m | (1 << i);
    }, 0);
  return (doc.prototype?.group ?? []).map((g) => {
    // The item search draws a fixed part on every placed building that carries it.
    const proxies = [...new Set((g.dispatch ?? []).flatMap((d) => (d.proxy ?? []).map((p) => p.type)))].sort();
    return {
      name: g.name,
      usage: mask(limits.usage, g.usage, "usage"),
      containers: (g.container ?? []).map((c) => ({
        categories: mask(limits.categories, c.category, "category"),
        tags: mask(limits.tags, c.tag, "tag"),
        points: (c.point ?? []).length,
      })),
      ...(proxies.length > 0 ? { proxies } : {}),
    };
  });
}

/**
 * The usages a building's loot points serve: its own group <usage> AND the areaflags.map usage
 * under it. The area flags are a second router beside the group, not a fallback for it (dayz
 * plugin, dayz-mapgroups references/cross-file.md rule 6: an ordinary house on a Military-painted
 * area spawns military loot).
 * ⚠️ A union, never `||`: preferring the group's own usage hid contaminated-zone loot (M4A1) from
 * every building that names a usage of its own.
 */
export function effectiveUsage(proto: WorldProto, areaUsage: number): number {
  return proto.usage | areaUsage;
}

/**
 * Proto index per type, by name; null when mapgroupproto has no such group.
 * ⚠️ Case-insensitive, as DayZ class names are: Nasdara's mapgrouppos and mapgroupproto disagree
 * on case for 37 buildings (Land_Store_Carservice, the refugee tents…), and an exact match left
 * them with no loot at all.
 */
export function linkProtos(types: { name: string }[], protos: WorldProto[]): (number | null)[] {
  const byName = new Map<string, number>();
  // If two groups ever differ only by case the first wins (Nasdara has none).
  protos.forEach((p, i) => { if (!byName.has(p.name.toLowerCase())) byName.set(p.name.toLowerCase(), i); });
  return types.map((t) => byName.get(t.name.toLowerCase()) ?? null);
}

// The loot layers the map offers. `usage` names must exist in limits.usage (a test checks).
export const LOOT_GROUPS: readonly { key: string; label: string; usage: string[] }[] = [
  { key: "military", label: "Military", usage: ["Military", "MilitaryEast", "MilitaryWest"] },
  { key: "police", label: "Police", usage: ["Police", "Prison"] },
  { key: "medical", label: "Medical", usage: ["Medic"] },
  { key: "fire", label: "Fire station", usage: ["Firefighter"] },
  { key: "industrial", label: "Industrial", usage: ["Industrial"] },
  { key: "town", label: "Town", usage: ["Town", "Office", "School", "Lunapark"] },
  { key: "village", label: "Village", usage: ["Village"] },
  { key: "farm", label: "Farm", usage: ["Farm"] },
  { key: "hunting", label: "Hunting", usage: ["Hunting"] },
  { key: "coast", label: "Coast", usage: ["Coast"] },
];

let cached: Promise<WorldFile> | null = null;

/** Fetched once per page load; a failure is not cached, so a retry can succeed. */
export function loadWorld(): Promise<WorldFile> {
  cached ??= fetch(`/map-data/${WORLD_MAP}/world.json`)
    .then((r) => {
      if (!r.ok) throw new Error(`world.json ${r.status}`);
      return r.json() as Promise<WorldFile>;
    })
    .catch((e) => {
      cached = null;
      throw e;
    });
  return cached;
}
