// The static world data the map layers draw from: event spawns, bunkers, contaminated zones,
// fresh-spawn points and the mission's building props. Built by hand from the Nasdara mission
// checkout (scripts/build-map-world.ts) and committed, so the web never reads the mission.
//
// Coordinates are DayZ world metres: x east, z north, 0..WORLD_SIZE_M. The y (height) the
// mission files carry is dropped here — the map is flat.
import { XMLParser } from "fast-xml-parser";
import { WORLD_MAP } from "@factions/domain";

export type WorldPoint = { x: number; z: number };
export type WorldEvent = { event: string; points: WorldPoint[] }; // cfgeventspawns name
export type WorldArea = { name: string; x: number; z: number; radius: number };
export type WorldProp = { type: number; x: number; z: number };
export type WorldType = { name: string; proto: number | null };

export type WorldFile = {
  version: 1;
  source: { commit: string; builtAt: string };
  events: WorldEvent[]; // only events with ≥1 position
  bunkers: WorldPoint[]; // cfgbunkerbroadcast.json proxies[].position [x,y,z] → {x, z}
  contaminated: WorldArea[]; // cfgEffectArea.json Areas[].Data.Pos/Radius
  playerSpawns: WorldPoint[]; // cfgplayerspawnpoints.xml <fresh> positions
  props: WorldProp[]; // mapgrouppos rows; `type` indexes `types`
  types: WorldType[]; // proto indexes `protos` (Task 5), null = no loot group
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
