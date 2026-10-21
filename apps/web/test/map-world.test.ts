import { describe, it, expect } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { WORLD_MAP, WORLD_SIZE_M } from "@factions/domain";
import {
  parseBunkers,
  parseEffectAreas,
  parseEventSpawns,
  parseGroupPositions,
  parsePlayerSpawns,
  parseProtos,
  parseEnvironmentFiles,
  parseTerritoryZones,
  readTerritories,
  effectiveUsage,
  linkProtos,
  LOOT_GROUPS,
  type WorldFile,
} from "../lib/map-world";
import { parseLimits } from "../lib/area-flags";

const fx = (name: string) => readFileSync(join(__dirname, "fixtures/mission", name), "utf8");

describe("map world parsers", () => {
  it("reads event positions as x/z, and drops an event with none", () => {
    const events = parseEventSpawns(fx("cfgeventspawns.xml"));
    expect(events.map((e) => e.event)).toEqual(["StaticWaterTruck", "VehicleTruck01"]);
    expect(events[0]!.points).toEqual([
      { x: 3144.477295, z: 4687.65625 },
      { x: 3666.478027, z: 10883.100586 },
    ]);
    // A single <pos> is an object, not an array, in fast-xml-parser's default shape.
    expect(events[1]!.points).toEqual([{ x: 100.5, z: 200.25 }]);
  });

  it("maps a bunker's [x, y, z] to {x, z}", () => {
    const b = parseBunkers(fx("cfgbunkerbroadcast.json"));
    expect(b).toHaveLength(2);
    expect(b[0]).toEqual({ x: 7216.415, z: 5706.95 });
  });

  it("reads contaminated areas", () => {
    const a = parseEffectAreas(fx("cfgEffectArea.json"));
    expect(a[0]).toEqual({ name: "Tunnel1", x: 5507, z: 5634, radius: 75 });
    expect(a).toHaveLength(2);
  });

  it("reads only the <fresh> spawn positions, not hop or travel", () => {
    expect(parsePlayerSpawns(fx("cfgplayerspawnpoints.xml"))).toEqual([
      { x: 10133, z: 4163 },
      { x: 2696, z: 9693 },
    ]);
  });

  it("reads a group's pos with the middle value as height", () => {
    const g = parseGroupPositions(fx("mapgrouppos.xml"));
    expect(g).toHaveLength(3);
    expect(g[0]).toEqual({ name: "Land_wreck_truck01_aban2_orange", x: 2005.421509, z: 4348.476563 });
  });
});

describe("territories", () => {
  it("lists the territory files cfgenvironment.xml loads, in its order", () => {
    expect(parseEnvironmentFiles(fx("cfgenvironment.xml"))).toEqual([
      "env/cattle_territories.xml", "env/hare_territories.xml", "env/fox_territories.xml", "env/zombie_territories.xml",
    ]);
  });

  it("reads every zone of every territory as x, z and radius", () => {
    expect(parseTerritoryZones(fx("env/hare_territories.xml"))).toEqual([
      { x: 12984, z: 1692, radius: 50 },
      { x: 12804.5, z: 1700, radius: 50 },
      { x: 100, z: 200, radius: 60 },
    ]);
    // One territory with one zone: a lone child is still a list.
    expect(parseTerritoryZones(fx("env/zombie_territories.xml"))).toEqual([{ x: 4473.14, z: 10987.4, radius: 80 }]);
    expect(parseTerritoryZones(fx("env/cattle_territories.xml"))).toEqual([]);
  });

  it("⚠️ splits infected from animals, reads only listed files, and reports a listed file that is missing", () => {
    const read = (path: string) => {
      const f = join(__dirname, "fixtures/mission", path);
      return existsSync(f) ? readFileSync(f, "utf8") : null;
    };
    const { territories, missing } = readTerritories(fx("cfgenvironment.xml"), read);
    expect(territories.infected).toEqual([{ x: 4473.14, z: 10987.4, radius: 80 }]);
    expect(territories.animals.map((a) => a.kind)).toEqual(["hare", "hare", "hare"]);
    // wolf_territories.xml is on disk but not listed: the game never loads it, so neither do we.
    expect(territories.animals.some((a) => a.x === 8901.07)).toBe(false);
    expect(missing).toEqual(["env/fox_territories.xml"]);
  });
});

describe("loot protos", () => {
  const limits = parseLimits(fx("cfglimitsdefinition.xml"));
  const protos = parseProtos(fx("mapgroupproto.xml"), limits);
  const bit = (list: string[], ...names: string[]) => names.reduce((m, n) => m | (1 << list.indexOf(n)), 0);

  it("gives Land_Mil_Barracks1 the Military bit and its two containers", () => {
    const b = protos.find((p) => p.name === "Land_Mil_Barracks1")!;
    expect(b.usage).toBe(bit(limits.usage, "Military"));
    expect(b.containers).toHaveLength(2);
    expect(b.containers[0]).toEqual({
      categories: bit(limits.categories, "tools", "containers"),
      tags: bit(limits.tags, "floor"),
      points: 9,
    });
    expect(b.containers[1]!.tags).toBe(bit(limits.tags, "shelves"));
    expect(b.containers[1]!.categories).toBe(bit(limits.categories, "tools", "containers", "clothes", "food", "books"));
  });

  it("gives a group with no <usage> a usage of 0", () => {
    const r = protos.find((p) => p.name === "Land_Airfield_Radar_Tall")!;
    expect(r.usage).toBe(0);
    expect(r.containers).toHaveLength(1);
  });

  it("keeps a group's dispatch proxies, and leaves the key off a group with none", () => {
    const xml = `<prototype>
      <group name="Land_Wreck_hb01_aban1_blue"><dispatch>
        <proxy type="HatchbackWheel" pos="1 0 0"/><proxy type="HatchbackHood_BlueRust" pos="0 0 1"/><proxy type="HatchbackWheel" pos="2 0 0"/>
      </dispatch></group>
      <group name="Land_Shed"><container name="c"><point pos="0 0 0"/></container></group>
    </prototype>`;
    const [wreck, shed] = parseProtos(xml, limits);
    expect(wreck!.proxies).toEqual(["HatchbackHood_BlueRust", "HatchbackWheel"]);
    expect(shed).not.toHaveProperty("proxies");
  });

  it("refuses a usage the limits file has no name for", () => {
    const bad = `<prototype><group name="X"><usage name="Nope"/></group></prototype>`;
    expect(() => parseProtos(bad, limits)).toThrow(/Nope/);
  });

  it("keeps a mapgrouppos type with no proto at null instead of throwing", () => {
    // ⚠️ mapgrouppos names props mapgroupproto never defines (wrecks, trees); they are not loot.
    expect(protos.some((p) => p.name === "Land_wreck_truck01_aban2_orange")).toBe(false);
    expect(linkProtos([{ name: "Land_wreck_truck01_aban2_orange" }, { name: "Land_Mil_Barracks1" }], protos)).toEqual([null, 0]);
  });

  it("⚠️ unions the building's own usage with the area flags, never one instead of the other", () => {
    const area = bit(limits.usage, "Town");
    const mil = bit(limits.usage, "Military");
    expect(effectiveUsage({ name: "a", usage: 0, containers: [] }, area)).toBe(area);
    // A Military building on a Town cell offers both: the area flags are a second router.
    expect(effectiveUsage({ name: "a", usage: mil, containers: [] }, area)).toBe(mil | area);
    expect(effectiveUsage({ name: "a", usage: mil, containers: [] }, 0)).toBe(mil);
  });

  it("⚠️ links a type to its proto case-insensitively, as DayZ names are", () => {
    // mapgrouppos and mapgroupproto disagree on case for 37 Nasdara buildings.
    expect(linkProtos([{ name: "LAND_MIL_BARRACKS1" }, { name: "land_mil_barracks1" }], protos)).toEqual([0, 0]);
  });
});

describe("committed world.json", () => {
  const world = JSON.parse(
    readFileSync(join(__dirname, `../public/map-data/${WORLD_MAP}/world.json`), "utf8"),
  ) as WorldFile;

  it("⚠️ is the contract: 23 bunkers, and every event has points inside the world", () => {
    expect(world.version).toBe(1);
    expect(world.source.commit).toMatch(/^[0-9a-f]{40}$/);
    expect(world.bunkers).toHaveLength(23);
    expect(world.events.length).toBeGreaterThan(0);
    for (const e of world.events) {
      expect(e.points.length).toBeGreaterThan(0);
      for (const p of e.points) {
        expect(p.x).toBeGreaterThanOrEqual(0);
        expect(p.x).toBeLessThanOrEqual(WORLD_SIZE_M);
        expect(p.z).toBeGreaterThanOrEqual(0);
        expect(p.z).toBeLessThanOrEqual(WORLD_SIZE_M);
      }
    }
  });

  it("carries the infected and animal territories inside the world", () => {
    // Nasdara 58a7c4d: 686 zombie zones; 500 animal zones (hare 278, wild boar 112, hen 110, cattle's file empty).
    expect(world.territories.infected).toHaveLength(686);
    expect(world.territories.animals).toHaveLength(500);
    const kinds = Object.fromEntries([...new Set(world.territories.animals.map((a) => a.kind))].map((k) => [k, world.territories.animals.filter((a) => a.kind === k).length]));
    expect(kinds).toEqual({ wild_boar: 112, hen: 110, hare: 278 });
    for (const z of [...world.territories.infected, ...world.territories.animals]) {
      expect(z.radius).toBeGreaterThan(0);
      expect(z.x).toBeGreaterThanOrEqual(0);
      expect(z.x).toBeLessThanOrEqual(WORLD_SIZE_M);
      expect(z.z).toBeGreaterThanOrEqual(0);
      expect(z.z).toBeLessThanOrEqual(WORLD_SIZE_M);
    }
  });

  it("indexes every prop into types", () => {
    expect(world.props.length).toBeGreaterThan(0);
    for (const p of world.props) expect(world.types[p.type]).toBeDefined();
  });

  it("stamps area usage and tier masks on props: a Land_Mil_ building sits on Military with a tier", () => {
    const mil = world.limits.usage.indexOf("Military");
    expect(mil).toBeGreaterThanOrEqual(0);
    const hit = world.props.some(
      (p) => world.types[p.type]!.name.startsWith("Land_Mil_") && (p.u & (1 << mil)) !== 0 && p.t !== 0,
    );
    expect(hit).toBe(true);
  });

  it("carries the full limits lists in bit order", () => {
    expect(world.limits.value.slice(0, 4)).toEqual(["Tier1", "Tier2", "Tier3", "Tier4"]);
    expect(world.limits.categories).toContain("tools");
    expect(world.limits.tags).toContain("floor");
  });

  it("⚠️ drift: every LOOT_GROUPS usage name exists in limits.usage", () => {
    for (const g of LOOT_GROUPS) for (const u of g.usage) expect(world.limits.usage, `${g.key}: ${u}`).toContain(u);
  });

  it("⚠️ links every Nasdara type to its proto by name, ignoring case", () => {
    // 37 of these differ only by case (Land_Store_Carservice…); an exact match left them null.
    // A type with no group still gets null — the unit test above holds that half.
    for (const t of world.types) {
      expect(t.proto, t.name).not.toBeNull();
      expect(world.protos[t.proto!]!.name.toLowerCase()).toBe(t.name.toLowerCase());
    }
  });

  it("carries the car wrecks' fixed parts (dispatch proxies) on their protos", () => {
    const wreck = world.protos.find((p) => p.name.toLowerCase() === "land_wreck_hb01_aban1_blue")!;
    expect(wreck.proxies).toContain("HatchbackWheel");
  });

  it("carries Land_Mil_Barracks1 with Military usage", () => {
    const b = world.protos.find((p) => p.name === "Land_Mil_Barracks1")!;
    expect(b.usage & (1 << world.limits.usage.indexOf("Military"))).not.toBe(0);
    expect(b.containers.length).toBeGreaterThan(0);
  });
});
