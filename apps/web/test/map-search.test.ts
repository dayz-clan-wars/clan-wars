import { describe, it, expect } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { WORLD_SIZE_M } from "@factions/domain";
import { placesFor } from "../lib/map-places";
import { COORD_HINT, latLngToWorld } from "../lib/map-projection";
import { readoutText, searchMap, searchZoom, type SearchCtx } from "../lib/map-search";
import { MapSearch, type MapSearchProps } from "../app/(site)/map/map-search";
import { reticlePopup } from "../app/(site)/map/map-draw";

const size = WORLD_SIZE_M;
/** The real Nasdara names, converted the way map-view.tsx converts them. */
const places = placesFor("nasdara", Infinity).map((p) => ({ name: p.name, ...latLngToWorld(p.lat, p.lng, size) }));
const bunkers = Array.from({ length: 23 }, (_, i) => ({ x: 1000 + i * 100, z: 2000 + i * 100 }));
const ctx: SearchCtx = { size, places, bunkers };

describe("searchMap", () => {
  it("reads a GPS ref as a coordinate and searches no names", () => {
    const r = searchMap("072 087", ctx);
    expect(r.coord?.kind).toBe("gps");
    expect(r.hits).toEqual([]);
  });

  it("reads metres as a coordinate", () => {
    expect(searchMap("7216 5706", ctx).coord).toEqual({ kind: "metres", x: 7216, z: 5706 });
  });

  it("gives the hint for numbers it cannot read, and no hits", () => {
    const r = searchMap("72 0870", ctx);
    expect(r.coord).toEqual({ kind: "bad", hint: COORD_HINT });
    expect(r.hits).toEqual([]);
  });

  it("puts No Abad first for 'no ab', matching any word start, case-insensitively", () => {
    const labels = searchMap("no ab", ctx).hits.map((h) => h.label);
    expect(labels[0]).toBe("No Abad");
    expect(labels).toContain("M12 No Abad");
    expect(labels).not.toContain("Salar Abad"); // "no" starts no word there
  });

  it("matches a later word on its own", () => {
    expect(searchMap("ABAD", ctx).hits.map((h) => h.label)).toEqual(expect.arrayContaining(["No Abad", "Salar Abad", "Gard Abad"]));
  });

  it("numbers bunkers from 1 in file order", () => {
    const hits = searchMap("bunker 7", ctx).hits;
    expect(hits[0]).toEqual({ tab: "locations", label: "Bunker 7", x: bunkers[6]!.x, z: bunkers[6]!.z });
    expect(hits.map((h) => h.label)).not.toContain("Bunker 17");
    expect(searchMap("bunker", ctx).hits.filter((h) => h.label.startsWith("Bunker "))).toHaveLength(23);
  });

  it("finds nothing for an empty query or a name that is not there", () => {
    expect(searchMap("   ", ctx)).toEqual({ coord: null, hits: [] });
    expect(searchMap("zzzz", ctx).hits).toEqual([]);
  });

  it("returns only location hits for now", () => {
    expect(searchMap("a", ctx).hits.every((h) => h.tab === "locations")).toBe(true);
  });
});

describe("searchZoom", () => {
  it("zooms in to 5, and never out", () => {
    expect(searchZoom(2)).toBe(5);
    expect(searchZoom(5.5)).toBe(5.5);
  });
});

describe("readoutText", () => {
  it("says the GPS and the metres", () => {
    expect(readoutText(7216.4, 9334.2, size)).toBe("GPS 072 / 070 · 7216, 9334");
  });
  it("keeps a point just past the edge on the map", () => {
    expect(readoutText(-3, size + 4, size)).toBe("GPS 000 / 000 · 0, 16384");
  });
});

describe("reticlePopup", () => {
  it("shows the GPS and the metres, and Pin it only with the pins layer", () => {
    const html = reticlePopup({ x: 7250, z: 9250 }, size, true);
    expect(html).toContain("GPS 072 071");
    expect(html).toContain("7250, 9250");
    expect(html).toContain("data-pin-it");
    expect(html).toContain(">Pin it<");
    expect(reticlePopup({ x: 7250, z: 9250 }, size, false)).not.toContain("data-pin-it");
  });
});

const base: MapSearchProps = { ctx, variant: "panel", onPick: () => {}, initial: "" };
const render = (p: Partial<MapSearchProps>) => renderToStaticMarkup(createElement(MapSearch, { ...base, ...p }));

describe("MapSearch", () => {
  it("is a labelled search box", () => {
    const html = render({});
    expect(html).toContain('type="search"');
    expect(html).toContain('aria-label="Search the map"');
  });

  it("lists the locations under their tab", () => {
    const html = render({ initial: "no ab" });
    expect(html).toContain(">Locations<");
    expect(html).toContain("No Abad");
    // Items and models arrive with later work: no empty tabs before then.
    expect(html).not.toContain(">Items<");
    expect(html).not.toContain(">Models<");
  });

  it("offers to go to a coordinate", () => {
    const html = render({ initial: "072 087" });
    expect(html).toContain("Go to GPS 072 087");
  });

  it("shows the hint under the box for numbers it cannot read", () => {
    expect(render({ initial: "72 0870" })).toContain(COORD_HINT);
  });

  it("says when nothing matches", () => {
    expect(render({ initial: "zzzz" })).toContain("Nothing on the map by that name.");
  });
});

describe("searchMap with hyphens", () => {
  const hy: SearchCtx = { size, places: [{ name: "Sar-e Pol", x: 1, z: 1 }, { name: "Pol Camp", x: 2, z: 2 }], bunkers: [] };
  it("matches a hyphenated name typed with the hyphen, or without it", () => {
    expect(searchMap("sar-e", hy).hits.map((h) => h.label)).toEqual(["Sar-e Pol"]);
    expect(searchMap("sar e pol", hy).hits.map((h) => h.label)).toEqual(["Sar-e Pol"]);
    expect(searchMap("e-pol", hy).hits.map((h) => h.label)).toEqual(["Sar-e Pol"]);
  });
});
