import { describe, it, expect } from "vitest";
import { parsePlayerPos, parsePoleAt, inMapBounds } from "../src/index.js";

// Real line from production. Note the two orderings inside ONE line:
//   player pos=<x, z, altitude>   pole at <x, altitude, z>
const FLAG_LINE =
  '12:55:19 | Player "XxBE4zyxX" (id=D34AD4C2D9A2D1068C2B4971CAA01177C20B24C1 ' +
  'pos=<2993.0, 1139.0, 448.3>) has lowered Flag_Livonia on TerritoryFlag ' +
  'at <2991.569092, 447.946503, 1138.587646>';

describe("parsePlayerPos", () => {
  it("reads pos=<x, z, altitude> into Vec3 with y as altitude", () => {
    expect(parsePlayerPos(FLAG_LINE)).toEqual({ x: 2993.0, y: 448.3, z: 1139.0 });
  });

  it("returns null when there is no pos block", () => {
    expect(parsePlayerPos('11:00:00 | Player "A" (id=AB) is connected')).toBeNull();
  });

  it("rejects the off-map sentinel in exponent notation", () => {
    expect(parsePlayerPos("pos=<-3.4e38, -3.4e38, 0>")).toBeNull();
  });

  it("rejects coordinates outside map bounds", () => {
    expect(parsePlayerPos("pos=<99999.0, 100.0, 5.0>")).toBeNull();
  });
});

describe("parsePoleAt", () => {
  it("reads at <x, altitude, z> into Vec3 with y as altitude", () => {
    expect(parsePoleAt(FLAG_LINE)).toEqual({ x: 2991.569092, y: 447.946503, z: 1138.587646 });
  });

  it("does not confuse the player pos block for the pole block", () => {
    const pole = parsePoleAt(FLAG_LINE);
    const player = parsePlayerPos(FLAG_LINE);
    expect(pole).not.toEqual(player);
  });

  it("returns null on a line with no TerritoryFlag clause", () => {
    expect(parsePoleAt('Player "A" (id=AB pos=<100.0, 200.0, 5.0>) folded Flag Pole')).toBeNull();
  });
});

describe("inMapBounds", () => {
  it("accepts in-range horizontals", () => {
    expect(inMapBounds(2991.5, 1138.5)).toBe(true);
  });
  it("rejects out-of-range horizontals", () => {
    expect(inMapBounds(-5000, 1138.5)).toBe(false);
  });
});
