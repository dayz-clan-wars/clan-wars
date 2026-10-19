import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { markerTitle } from "../lib/map-labels";

const MAP = join(import.meta.dirname, "..", "app", "(site)", "map");
/** A point whose metre values would be recognisable if they ever leaked into text. */
const X = 4321.7, Z = 8765.2;

describe("markerTitle", () => {
  it("names each kind of marker, with its age where it has one", () => {
    expect(markerTitle.you("14 min ago")).toBe("You, last seen 14 min ago");
    expect(markerTitle.clanmate("Bob", "3 h ago")).toBe("Bob, clanmate, 3 h ago");
    expect(markerTitle.intruder("Stranger", 42.4, "just now")).toBe("Stranger, intruder, 42 m from your base, just now");
    expect(markerTitle.bounty("Wanted1", "2 min ago")).toBe("Wanted1, wanted, 2 min ago");
    expect(markerTitle.pin("Loot", X, Z, "yesterday")).toBe("Loot pin, grid 043 087, yesterday");
  });

  /**
   * ⚠️ A title is copyable text in the accessibility tree. It carries the
   * map's one rule (map-draw.ts): grid refs, never a metre coordinate.
   */
  it("speaks grid refs, never a metre coordinate", () => {
    for (const t of [markerTitle.base(X, Z, 100), markerTitle.pin("Loot", X, Z, "3 h ago"), markerTitle.publicBase(X, Z)]) {
      expect(t).toContain("grid 043 087");
      expect(t).not.toMatch(/4321|8765/u);
    }
  });
});

describe("every marker a player can open is reachable by keyboard and named", () => {
  const draw = readFileSync(join(MAP, "map-draw.ts"), "utf8");
  const markers = draw.match(/L\.marker\([\s\S]*?\}\)/gu) ?? [];

  it("finds all eight marker calls", () => {
    expect(markers).toHaveLength(8);
  });

  it.each(markers)("%s", (call) => {
    // Travel points are not interactive: 209 tab stops with nothing to open.
    if (call.includes("TRAVEL_PANE")) {
      expect(call).toContain("keyboard: false");
      return;
    }
    // Public bases open nothing (a tooltip, no popup) and are not in the "On
    // the map" list, so as tab stops they only interleaved strangers' bases
    // with the player's own markers. Still named, for a pointer's hover.
    if (call.includes("markerTitle.publicBase")) {
      expect(call).toContain("keyboard: false");
      expect(call).toContain("title: markerTitle.publicBase(");
      return;
    }
    expect(call).toContain("keyboard: true");
    expect(call).toContain("title: markerTitle.");
  });
});

describe("the page names the map", () => {
  const view = readFileSync(join(MAP, "map-view.tsx"), "utf8");

  it("has an h1", () => {
    expect(view).toContain('<h1 className="sr-only">The map</h1>');
  });

  it("names Leaflet's container as a region", () => {
    expect(view).toMatch(/<div ref=\{el\} role="region" aria-label=\{MAP_REGION_LABEL\}/u);
  });
});
