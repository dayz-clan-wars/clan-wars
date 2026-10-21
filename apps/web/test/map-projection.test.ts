import { describe, it, expect } from "vitest";
import { CANVAS_PX, MAX_ZOOM, worldToPixel, worldToLatLng, latLngToWorld, gridRef, gridRefKey, parseGridRef, parseCoordQuery, COORD_HINT } from "../lib/map-projection";

/**
 * ⚠️ The whole map hangs off these four functions. A sign error here does not
 * throw — it draws every dot in the wrong hemisphere of a plausible-looking
 * map, which nobody reports as a bug because the map still renders.
 *
 * DayZ's origin is bottom-left with z as northing; Leaflet's pixel origin is
 * top-left with y going down. The corner table below is the flip, stated as
 * data rather than as prose.
 */
const SIZE = 12800;

describe("worldToPixel", () => {
  it("puts the world's four corners on the canvas's four corners", () => {
    expect(worldToPixel(0, 0, SIZE)).toEqual([0, CANVAS_PX]);
    expect(worldToPixel(0, SIZE, SIZE)).toEqual([0, 0]);
    expect(worldToPixel(SIZE, SIZE, SIZE)).toEqual([CANVAS_PX, 0]);
    expect(worldToPixel(SIZE, 0, SIZE)).toEqual([CANVAS_PX, CANVAS_PX]);
  });

  it("scales linearly — the centre is the centre", () => {
    expect(worldToPixel(SIZE / 2, SIZE / 2, SIZE)).toEqual([CANVAS_PX / 2, CANVAS_PX / 2]);
  });

  it("takes canvasPx as a parameter, so a wrong pyramid is a one-line fix", () => {
    expect(worldToPixel(SIZE, 0, SIZE, 1024)).toEqual([1024, 1024]);
  });
});

describe("worldToLatLng", () => {
  it("is worldToPixel divided by the pyramid's scale, with y negated", () => {
    const scale = 2 ** MAX_ZOOM;
    expect(worldToLatLng(0, SIZE, SIZE)).toEqual({ lat: -0, lng: 0 });
    expect(worldToLatLng(SIZE, 0, SIZE)).toEqual({ lat: -CANVAS_PX / scale, lng: CANVAS_PX / scale });
  });
});

describe("latLngToWorld", () => {
  // The pin form's coordinates come back through this. A round-trip that
  // drifts drops the pin somewhere other than where the player pressed.
  it.each([
    ["the Hub", 100, 93],
    ["the far corner", SIZE, 0],
    ["the origin", 0, 0],
    ["a fix", 6712.5, 2399.25],
  ])("round-trips %s to within 0.01 m", (_name, x, z) => {
    const { lat, lng } = worldToLatLng(x as number, z as number, SIZE);
    const back = latLngToWorld(lat, lng, SIZE);
    expect(back.x).toBeCloseTo(x as number, 2);
    expect(back.z).toBeCloseTo(z as number, 2);
  });
});

// The GPS cases are the real Nasdara world (WORLD_SIZE_M); the projection tests above use a 12800 m fixture.
const GPS_SIZE = 16384;

describe("gridRef (in-game GPS: second number counts down from the north edge)", () => {
  it("is metres over 100, z flipped, zero-padded", () => {
    expect(gridRef(7216, 5706, GPS_SIZE)).toBe("072 106"); // (16384-5706)/100 = 106.78
    expect(gridRef(0, GPS_SIZE, GPS_SIZE)).toBe("000 000"); // top-left is 000 000
    expect(gridRef(0, 87, GPS_SIZE)).toBe("000 162");
  });

  it("defaults to the world size", () => {
    expect(gridRef(7216, 5706)).toBe("072 106");
  });

  it("clamps outside the world rather than printing a minus sign", () => {
    expect(gridRef(-5, GPS_SIZE + 50, GPS_SIZE)).toBe("000 000");
  });
});

describe("grid refs both ways", () => {
  it("keys drop the space and parse back to the cell's centre", () => {
    expect(gridRefKey(7216, 5706, GPS_SIZE)).toBe("072106");
    expect(parseGridRef("072106", GPS_SIZE)).toEqual({ x: 7250, z: 16384 - 10650 });
  });
  it("refuses anything that is not six digits inside the world", () => {
    expect(parseGridRef("164000", GPS_SIZE)).toBeNull();
    expect(parseGridRef("43087", GPS_SIZE)).toBeNull();
    expect(parseGridRef(null, GPS_SIZE)).toBeNull();
    expect(parseGridRef("04308a", GPS_SIZE)).toBeNull();
  });
});

describe("parseCoordQuery", () => {
  it("reads GPS cells", () => {
    expect(parseCoordQuery("072 087", GPS_SIZE)).toEqual({ kind: "gps", x: 7250, z: 16384 - 8750 });
    expect(parseCoordQuery("072/087", GPS_SIZE)?.kind).toBe("gps");
    expect(parseCoordQuery("072,087", GPS_SIZE)?.kind).toBe("gps");
    expect(parseCoordQuery("100 200", GPS_SIZE)?.kind).toBe("gps");
    expect(parseCoordQuery("163 000", GPS_SIZE)?.kind).toBe("gps");
  });
  it("reads metres", () => {
    expect(parseCoordQuery("7216 5706", GPS_SIZE)).toEqual({ kind: "metres", x: 7216, z: 5706 });
    expect(parseCoordQuery("0100 0200", GPS_SIZE)).toEqual({ kind: "metres", x: 100, z: 200 });
  });
  it("refuses numbers it cannot place, with a hint", () => {
    const bad = { kind: "bad", hint: COORD_HINT };
    expect(parseCoordQuery("164 000", GPS_SIZE)).toEqual(bad);
    expect(parseCoordQuery("20000 100", GPS_SIZE)).toEqual(bad);
    expect(parseCoordQuery("12 34", GPS_SIZE)).toEqual(bad);
    expect(parseCoordQuery("072 7216", GPS_SIZE)).toEqual(bad);
  });
  it("leaves names to the name search", () => {
    expect(parseCoordQuery("No Abad", GPS_SIZE)).toBeNull();
    expect(parseCoordQuery("072", GPS_SIZE)).toBeNull();
  });
});
