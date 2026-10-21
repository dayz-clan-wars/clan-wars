import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { WORLD_MAP, WORLD_SIZE_M } from "@factions/domain";
import {
  parseBunkers,
  parseEffectAreas,
  parseEventSpawns,
  parseGroupPositions,
  parsePlayerSpawns,
  type WorldFile,
} from "../lib/map-world";

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
});
