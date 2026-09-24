import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { motionOptions, prefersReducedMotion } from "../lib/map-motion";

describe("motionOptions", () => {
  it("turns off every Leaflet animation for a visitor who asked for less motion", () => {
    expect(motionOptions(true)).toEqual({ zoomAnimation: false, fadeAnimation: false, markerZoomAnimation: false, inertia: false });
  });

  it("leaves Leaflet's defaults otherwise", () => {
    expect(motionOptions(false)).toEqual({ zoomAnimation: true, fadeAnimation: true, markerZoomAnimation: true, inertia: true });
  });

  it("reads no preference, safely, where there is no window", () => {
    expect(prefersReducedMotion()).toBe(false);
  });
});

describe("map-view.tsx moves the view the same way", () => {
  const view = readFileSync(join(import.meta.dirname, "..", "app", "(site)", "map", "map-view.tsx"), "utf8");

  it("builds the map with motionOptions", () => {
    expect(view).toContain("...motionOptions(prefersReducedMotion())");
  });

  it("never animates a recentre or a list jump unconditionally", () => {
    expect(view).not.toContain("animate: true");
    expect(view.match(/animate: !prefersReducedMotion\(\)/gu)).toHaveLength(2);
  });
});
