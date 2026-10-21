// The static world data the map layers draw from: event spawns, bunkers, contaminated zones,
// fresh-spawn points and the mission's building props. Built by hand from the Nasdara mission
// checkout (scripts/build-map-world.ts) and committed, so the web never reads the mission.
//
// Coordinates are DayZ world metres: x east, z north, 0..WORLD_SIZE_M. The y (height) the
// mission files carry is dropped here — the map is flat.
import { XMLParser } from "fast-xml-parser";
import { WORLD_MAP } from "@factions/domain";
import type { parseLimits } from "./area-flags";

export type WorldPoint = { x: number; z: number };
export type WorldEvent = { event: string; points: WorldPoint[] }; // cfgeventspawns name
export type WorldArea = { name: string; x: number; z: number; radius: number };
// u / t: the areaflags.map usage and value (tier) bitmasks at the prop's position; bit k is
// entry k of WorldFile.limits.usage / .value.
export type WorldProp = { type: number; x: number; z: number; u: number; t: number };
export type WorldType = { name: string; proto: number | null };
export type WorldProto = {
  name: string;
  usage: number; // group <usage> mask, 0 = none (fall back to area flags)
  containers: { categories: number; tags: number; points: number }[]; // masks over limits.categories / limits.tags
};

export type WorldFile = {
  version: 1;
  limits: ReturnType<typeof parseLimits>; // cfglimitsdefinition.xml lists, in bit order
  source: { commit: string; builtAt: string };
  events: WorldEvent[]; // only events with ≥1 position
  bunkers: WorldPoint[]; // cfgbunkerbroadcast.json proxies[].position [x,y,z] → {x, z}
  contaminated: WorldArea[]; // cfgEffectArea.json Areas[].Data.Pos/Radius
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
  container?: { category?: Named[]; tag?: Named[]; point?: unknown[] }[];
};

/** mapgroupproto.xml groups. Names resolve to bits via `limits`; an unknown name throws. */
export function parseProtos(text: string, limits: ReturnType<typeof parseLimits>): WorldProto[] {
  const doc = xml("group", "container", "usage", "category", "tag", "point").parse(text) as {
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
  return (doc.prototype?.group ?? []).map((g) => ({
    name: g.name,
    usage: mask(limits.usage, g.usage, "usage"),
    containers: (g.container ?? []).map((c) => ({
      categories: mask(limits.categories, c.category, "category"),
      tags: mask(limits.tags, c.tag, "tag"),
      points: (c.point ?? []).length,
    })),
  }));
}

/** A building's own group usage wins; the area flags only fill in when the group names none. */
export function effectiveUsage(proto: WorldProto, areaUsage: number): number {
  return proto.usage || areaUsage;
}

/** Proto index per type, by name; null when mapgroupproto has no such group. */
export function linkProtos(types: { name: string }[], protos: WorldProto[]): (number | null)[] {
  const byName = new Map(protos.map((p, i) => [p.name, i]));
  return types.map((t) => byName.get(t.name) ?? null);
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
