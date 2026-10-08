import { describe, it, expect } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { BUNKER_ROOMS } from "../src/index.js";

// ⚠️ Two statements of one fact (CLAUDE.md): the chernarus repo holds the rooms;
// this package vendors them for picking and announcing. Skipped where the sibling
// checkout is absent (CI). It reads that checkout's WORKING TREE: if it fails on
// renames you have not pulled yet, `git -C ../chernarus pull` (never commit there;
// it is someone's working copy).
const CHERNARUS = join(__dirname, "../../../../chernarus");
const FILE = join(CHERNARUS, "custom/keycard-rooms.json");

describe.skipIf(!existsSync(FILE))("bunker rooms vs the chernarus repo", () => {
  it("names, positions and yaws match custom/keycard-rooms.json", () => {
    const objs = JSON.parse(readFileSync(FILE, "utf8")).Objects as { customString: string; pos: number[]; ypr: number[] }[];
    expect(BUNKER_ROOMS.map((r) => [r.name, r.x, r.y, r.z, r.yaw]))
      .toEqual(objs.map((o) => [o.customString, o.pos[0], o.pos[1], o.pos[2], o.ypr[0]]));
  });
});
