import { describe, it, expect } from "vitest";
import { PLACE_FALLBACK_MIN_ZOOM, placeMinZoom, placeWeight, placesFor } from "../lib/map-places";
import { MAX_ZOOM, zoomFloor } from "../lib/map-projection";

describe("map places", () => {
  it("has Livonia's sixty places, every one inside the zoom-6 pyramid", () => {
    const all = placesFor("enoch", MAX_ZOOM);
    expect(all).toHaveLength(60);
    for (const p of all) {
      expect(p.lat).toBeLessThanOrEqual(0); expect(p.lat).toBeGreaterThanOrEqual(-256);
      expect(p.lng).toBeGreaterThanOrEqual(0); expect(p.lng).toBeLessThanOrEqual(256);
      expect(p.name).not.toBe("");
    }
    expect(all.map((p) => p.name)).toContain("Topolin");
  });

  it("tiers by zoom: cities always, villages from 2, the rest from 4, unknown kinds most restrictive", () => {
    expect(placeMinZoom("city")).toBe(0);
    expect(placeMinZoom("village")).toBe(2);
    expect(placeMinZoom("hill")).toBe(PLACE_FALLBACK_MIN_ZOOM);
    expect(placeMinZoom("something-new")).toBe(PLACE_FALLBACK_MIN_ZOOM);
    expect(placesFor("enoch", 0).every((p) => p.kind === "city" || p.kind === "capital")).toBe(true);
    expect(placesFor("enoch", 1.75).some((p) => p.kind === "village")).toBe(false);
    expect(placesFor("enoch", 2).some((p) => p.kind === "village")).toBe(true);
    expect(placesFor("enoch", 3.75).some((p) => p.kind === "hill")).toBe(false);
    expect(placesFor("enoch", 4).some((p) => p.kind === "hill")).toBe(true);
  });

  it("an unknown map has no places, never a throw", () => {
    expect(placesFor("chernarusplus", 6)).toEqual([]);
  });

  it("weights settlements louder than terrain", () => {
    expect(placeWeight("city")).toBe("major");
    expect(placeWeight("village")).toBe("minor");
    expect(placeWeight("marine")).toBe("faint");
  });
});

describe("zoomFloor", () => {
  it("is where one tile pyramid just covers the longer side, rounded up to a snap point", () => {
    expect(zoomFloor(256, 256)).toBe(0);
    expect(zoomFloor(512, 300)).toBe(1);
    expect(zoomFloor(300, 1000)).toBe(2);      // log2(1000/256) = 1.97 → 2
    expect(zoomFloor(1280, 800)).toBe(2.5);    // log2(5) = 2.32 → 2.5
    expect(zoomFloor(1920, 1080)).toBe(3);     // log2(7.5) = 2.91 → 3
    expect(zoomFloor(390, 700)).toBe(1.5);     // log2(2.73) = 1.45 → 1.5
  });

  it("⚠️ never below zero, and null for an empty container or one wider than the whole pyramid", () => {
    expect(zoomFloor(100, 100)).toBe(0);
    expect(zoomFloor(0, 0)).toBeNull();
    expect(zoomFloor(256 * 2 ** MAX_ZOOM * 2, 100)).toBeNull();
  });
});
