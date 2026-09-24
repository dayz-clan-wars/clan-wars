import { describe, it, expect, afterEach, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { motionOptions, popupOptions, prefersReducedMotion } from "../lib/map-motion";

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

describe("popupOptions", () => {
  const base = { className: "cw-map-popup", closeButton: true } as const;

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("keeps the base options and Leaflet's default autoPan where there is no preference", () => {
    // No `window` in this suite's (node) test environment, so prefersReducedMotion()
    // reads "no preference" the same way a real browser would with the query unset.
    expect(popupOptions(base)).toEqual({ ...base, autoPan: true });
  });

  it("turns autoPan off under reduced motion, leaving the rest of the base options alone", () => {
    vi.stubGlobal("window", { matchMedia: () => ({ matches: true }) });
    expect(popupOptions(base)).toEqual({ ...base, autoPan: false });
  });

  it("leaves autoPan on when the visitor has no preference, explicitly", () => {
    vi.stubGlobal("window", { matchMedia: () => ({ matches: false }) });
    expect(popupOptions(base)).toEqual({ ...base, autoPan: true });
  });
});

describe("map-draw.ts's popups all route through popupOptions", () => {
  const draw = readFileSync(join(import.meta.dirname, "..", "app", "(site)", "map", "map-draw.ts"), "utf8");
  const bindings = draw.match(/\.bindPopup\([\s\S]*?\);/gu) ?? [];

  it("binds at least the popups this map has", () => {
    expect(bindings.length).toBeGreaterThan(0);
  });

  it("never passes the bare POPUP object — every site wraps it in popupOptions(...)", () => {
    for (const binding of bindings) {
      expect(binding).toContain("popupOptions(POPUP)");
      expect(binding).not.toMatch(/,\s*POPUP\s*\)/u);
    }
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
