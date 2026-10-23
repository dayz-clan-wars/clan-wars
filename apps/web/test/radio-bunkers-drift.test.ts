import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it, expect } from "vitest";
import { BUNKER_GRID_KEYS, isBunkerGrid } from "@/lib/radio/bunkers";
import { gridRefKey } from "@/lib/map-projection";
import type { WorldFile } from "@/lib/map-world";

// ⚠️ The radio page ships the bunker squares as a literal because /map-data/
// is behind sign-in and the page is not. Two statements of one fact: this
// holds the literal to the world file the map draws.
describe("BUNKER_GRID_KEYS", () => {
  const world = JSON.parse(readFileSync(join(__dirname, "..", "public", "map-data", "nasdara", "world.json"), "utf8")) as WorldFile;

  it("matches every bunker in world.json", () => {
    expect([...new Set(world.bunkers.map((b) => gridRefKey(b.x, b.z)))].sort()).toEqual([...BUNKER_GRID_KEYS]);
  });

  it("holds the three bunkers the recording named", () => {
    for (const k of ["091044", "100121", "028100"]) expect(isBunkerGrid(k)).toBe(true);
    expect(isBunkerGrid("555555")).toBe(false);
  });
});
