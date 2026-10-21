// Builds public/map-data/nasdara/world.json from the Nasdara mission checkout. Run by hand
// after a mission change, then commit the output (the web never reads the mission):
//
//   pnpm --filter @factions/web map:world                  # ../nasdara beside this repo
//   pnpm --filter @factions/web map:world --mission <dir>
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { WORLD_MAP } from "@factions/domain";
import { decodeAreaFlags, parseLimits } from "../lib/area-flags";
import {
  parseBunkers,
  parseEffectAreas,
  parseEventSpawns,
  parseGroupPositions,
  parsePlayerSpawns,
  parseProtos,
  linkProtos,
  effectiveUsage,
  LOOT_GROUPS,
  type WorldFile,
} from "../lib/map-world";
import { eventChildren } from "../lib/item-index";

const here = dirname(fileURLToPath(import.meta.url));
// Resolved from the script's location, not the cwd: pnpm runs it from apps/web.
const repoRoot = resolve(here, "../../..");
const argIdx = process.argv.indexOf("--mission");
const mission = resolve(argIdx >= 0 ? process.argv[argIdx + 1]! : join(repoRoot, "../nasdara"));
const out = join(here, `../public/map-data/${WORLD_MAP}/world.json`);

const read = (f: string) => readFileSync(join(mission, f), "utf8");

// Each event with the classes it places (its wrecks), for the item search's deloot.
const children = eventChildren(read("db/events.xml"), read("cfgeventspawns.xml"), read("cfgeventgroups.xml"));
const events = parseEventSpawns(read("cfgeventspawns.xml")).map((e) => {
  const c = children.get(e.event);
  return c && c.length > 0 ? { ...e, children: c } : e;
});
const bunkers = parseBunkers(read("cfgbunkerbroadcast.json"));
const contaminated = parseEffectAreas(read("cfgEffectArea.json"));
const playerSpawns = parsePlayerSpawns(read("cfgplayerspawnpoints.xml"));
const groups = parseGroupPositions(read("mapgrouppos.xml"));
const limits = parseLimits(read("cfglimitsdefinition.xml"));
const flags = decodeAreaFlags(readFileSync(join(mission, "areaflags.map")));

// Class names repeat thousands of times; store each once and index it.
const typeIndex = new Map<string, number>();
const types: WorldFile["types"] = [];
const props = groups.map((g) => {
  let i = typeIndex.get(g.name);
  if (i === undefined) {
    i = types.length;
    typeIndex.set(g.name, i);
    types.push({ name: g.name, proto: null });
  }
  const f = flags.at(g.x, g.z);
  return { type: i, x: g.x, z: g.z, u: f.usage, t: f.value };
});

const protos = parseProtos(read("mapgroupproto.xml"), limits);
// A mapgrouppos type with no group in mapgroupproto (wrecks, trees) keeps proto: null.
linkProtos(types, protos).forEach((p, i) => (types[i]!.proto = p));

const commit = execFileSync("git", ["-C", mission, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
const world: WorldFile = {
  version: 1,
  limits,
  source: { commit, builtAt: new Date().toISOString() },
  events,
  bunkers,
  contaminated,
  playerSpawns,
  props,
  types,
  protos,
};

mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, JSON.stringify(world));

for (const name of ["StaticWaterTruck", "VehicleTruck01", "VehicleCivilianSedan", "ItemBricks", "StaticContainerLocked"]) {
  console.log(name, events.find((e) => e.event === name)?.points.length ?? 0);
}
console.log("events", events.length);
console.log("bunkers", bunkers.length);
console.log("contaminated", contaminated.length);
console.log("playerSpawns", playerSpawns.length);
console.log("props", props.length);
console.log("types", types.length);
console.log("protos", protos.length);
console.log("types with a proto", types.filter((t) => t.proto !== null).length);
for (const g of LOOT_GROUPS) {
  const mask = g.usage.reduce((m, u) => m | (1 << limits.usage.indexOf(u)), 0);
  const n = props.filter((p) => {
    const proto = types[p.type]!.proto;
    return proto !== null && (effectiveUsage(protos[proto]!, p.u) & mask) !== 0;
  }).length;
  console.log("loot", g.key, n);
}
