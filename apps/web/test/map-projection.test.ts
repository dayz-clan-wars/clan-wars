import { describe, it, expect } from "vitest";
import { CANVAS_PX, MAX_ZOOM, worldToPixel, worldToLatLng, latLngToWorld, gridRef } from "../lib/map-projection";

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

describe("gridRef", () => {
  it("is metres over 100, truncated, zero-padded — what players say out loud", () => {
    expect(gridRef(6712, 2399)).toBe("067 023");
  });

  it("pads short cells to three digits", () => {
    expect(gridRef(0, 0)).toBe("000 000");
    expect(gridRef(999, 12799)).toBe("009 127");
  });

  it("clamps negatives rather than printing a minus sign", () => {
    // Panning past the world's edge is ordinary; a "-01 -02" readout is not.
    expect(gridRef(-5, -1200)).toBe("000 000");
  });
});
