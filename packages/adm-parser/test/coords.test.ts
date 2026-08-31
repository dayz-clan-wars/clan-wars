import { describe, it, expect } from "vitest";
import { parsePlayerPos, parsePoleAt, inMapBounds, inAltitudeBounds } from "../src/index.js";

// Real line from production. Note the two orderings inside ONE line:
//   player pos=<x, z, altitude>   pole at <x, altitude, z>
const FLAG_LINE =
  '12:55:19 | Player "XxBE4zyxX" (id=D34AD4C2D9A2D1068C2B4971CAA01177C20B24C1 ' +
  'pos=<2993.0, 1139.0, 448.3>) has lowered Flag_Livonia on TerritoryFlag ' +
  'at <2991.569092, 447.946503, 1138.587646>';

// The bounds tests below MUST carry a real identity block. The coordinate
// parsers are anchored to it, so a bare `pos=<...>` string returns null for the
// anchor's sake and the assertion would hold even if inMapBounds were deleted.
const ID40 = "D34AD4C2D9A2D1068C2B4971CAA01177C20B24C1";

describe("parsePlayerPos", () => {
  it("reads pos=<x, z, altitude> into Vec3 with y as altitude", () => {
    expect(parsePlayerPos(FLAG_LINE)).toEqual({ x: 2993.0, y: 448.3, z: 1139.0 });
  });

  it("returns null when there is no pos block", () => {
    expect(parsePlayerPos('11:00:00 | Player "A" (id=AB) is connected')).toBeNull();
  });

  it("rejects the off-map sentinel in full decimal expansion", () => {
    // This is exactly how DayZ writes it — 134 such lines in the production
    // export, no e-notation anywhere. inMapBounds is the only thing that
    // rejects it, because the value falls far below MAP_MIN.
    const sentinel = "-340282346638528859811704183484516925440.0";
    expect(parsePlayerPos(`Player "A" (id=${ID40} pos=<${sentinel}, ${sentinel}, 0>)`)).toBeNull();
  });

  it("also rejects the sentinel written in exponent notation", () => {
    expect(parsePlayerPos(`Player "A" (id=${ID40} pos=<-3.4e38, -3.4e38, 0>)`)).toBeNull();
  });

  it("rejects coordinates outside map bounds", () => {
    expect(parsePlayerPos(`Player "A" (id=${ID40} pos=<99999.0, 100.0, 5.0>)`)).toBeNull();
  });

  it("rejects the off-map sentinel in the ALTITUDE slot", () => {
    // ⚠️ The altitude was previously unvalidated, so this parsed. It reaches
    // the ceremony detector as a pole key of "3000.00:-3.4028234663852886e+38:1100.00"
    // — toFixed(2) gives up on exponential notation at 1e21 — which
    // parsePoleKey then refuses, and the throw that follows wedged the whole
    // tick for every server, forever.
    const sentinel = "-340282346638528859811704183484516925440.0";
    expect(parsePlayerPos(`Player "A" (id=${ID40} pos=<3000.0, 1100.0, ${sentinel}>)`)).toBeNull();
  });

  it("rejects an altitude that would overflow numeric(12,2)", () => {
    // The milder failure than the sentinel: 1e10 renders fine through
    // toFixed(2), so the pole key parses — and then blows up on INSERT
    // against numeric(12,2), which holds at most 10 digits before the point.
    expect(parsePlayerPos(`Player "A" (id=${ID40} pos=<3000.0, 1100.0, 10000000000.0>)`)).toBeNull();
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

  it("rejects a pole whose altitude is the off-map sentinel", () => {
    // The pole clause puts altitude in the MIDDLE, and this is the value that
    // becomes the ceremony detector's pole key.
    const sentinel = "-340282346638528859811704183484516925440.0";
    const raw = `12:55:19 | Player "A" (id=${ID40} pos=<2993.0, 1139.0, 448.3>) ` +
      `has raised Flag_White on TerritoryFlag at <2991.57, ${sentinel}, 1138.59>`;
    expect(parsePoleAt(raw)).toBeNull();
  });
});

describe("inMapBounds", () => {
  it("accepts in-range horizontals", () => {
    expect(inMapBounds(2991.5, 1138.5)).toBe(true);
  });
  it("rejects out-of-range horizontals", () => {
    expect(inMapBounds(-5000, 1138.5)).toBe(false);
  });
  it("accepts the far edge of the largest supported terrain (16384m)", () => {
    expect(inMapBounds(16384, 16384)).toBe(true);
  });
});

describe("inAltitudeBounds", () => {
  it("accepts a real pole altitude", () => {
    expect(inAltitudeBounds(447.95)).toBe(true);
  });
  it("accepts an ocean-floor altitude", () => {
    expect(inAltitudeBounds(-120)).toBe(true);
  });
  it("rejects the off-map sentinel", () => {
    expect(inAltitudeBounds(-340282346638528859811704183484516925440.0)).toBe(false);
  });
  it("rejects an altitude that would overflow numeric(12,2)", () => {
    expect(inAltitudeBounds(1e10)).toBe(false);
  });
});

describe("coordinate parsers against adversarial gamertags", () => {
  const ID = "D34AD4C2D9A2D1068C2B4971CAA01177C20B24C1";
  const genuine = (name: string) =>
    `05:17:25 | Player "${name}" (id=${ID} ` +
    "pos=<2992.5, 1137.4, 448.1>) has raised Flag_Livonia on TerritoryFlag " +
    "at <2991.569092, 447.946503, 1138.587646>";

  it("reads the pos inside the identity block, not one in the gamertag", () => {
    expect(parsePlayerPos(genuine("pos=<5000.0, 5000.0, 100.0>"))).toEqual({
      x: 2992.5,
      y: 448.1,
      z: 1137.4,
    });
  });

  it("reads the pole clause after the identity block, not one in the gamertag", () => {
    expect(parsePoleAt(genuine("on TerritoryFlag at <5000.0, 100.0, 5000.0>"))).toEqual({
      x: 2991.569092,
      y: 447.946503,
      z: 1138.587646,
    });
  });

  it("does not read a pole clause that exists only in the gamertag", () => {
    const raw =
      `05:17:25 | Player "on TerritoryFlag at <5000.0, 100.0, 5000.0>" ` +
      `(id=${ID} pos=<2992.5, 1137.4, 448.1>) has been disconnected`;
    expect(parsePoleAt(raw)).toBeNull();
  });

  it("does not read a pos that exists only in the gamertag", () => {
    const raw = `05:17:25 | Player "pos=<5000.0, 5000.0, 100.0>" (id=${ID}) is connected`;
    expect(parsePlayerPos(raw)).toBeNull();
  });
});
