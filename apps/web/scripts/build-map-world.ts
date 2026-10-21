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
  type WorldFile,
} from "../lib/map-world";

const here = dirname(fileURLToPath(import.meta.url));
// Resolved from the script's location, not the cwd: pnpm runs it from apps/web.
const repoRoot = resolve(here, "../../..");
const argIdx = process.argv.indexOf("--mission");
const mission = resolve(argIdx >= 0 ? process.argv[argIdx + 1]! : join(repoRoot, "../nasdara"));
const out = join(here, `../public/map-data/${WORLD_MAP}/world.json`);

const read = (f: string) => readFileSync(join(mission, f), "utf8");

const events = parseEventSpawns(read("cfgeventspawns.xml"));
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
    // proto stays null until Task 5 links loot groups.
    types.push({ name: g.name, proto: null });
  }
  const f = flags.at(g.x, g.z);
  return { type: i, x: g.x, z: g.z, u: f.usage, t: f.value };
});

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
