import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createElement } from "react";
import type { WorldFile } from "../lib/map-world";
import { modelCounts, modelItems, modelLabel, modelPoints } from "../lib/world-layers";
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

  it("returns only location hits until the item index is in", () => {
    expect(searchMap("a", ctx).hits.every((h) => h.tab === "locations")).toBe(true);
  });
});

describe("searchMap items", () => {
  const items = ["M4A1", "M4_Suppressor", "Mag_STANAG_30Rnd", "SodaCan_Cola", "TunaCan", "AKM"].map((className) => ({ className }));
  const withItems: SearchCtx = { ...ctx, items };
  const itemHits = (q: string) => searchMap(q, withItems).hits.filter((h) => h.tab === "items");

  it("finds M4A1 for \"m4a1\", labelled with its class name", () => {
    expect(itemHits("m4a1")).toEqual([{ tab: "items", className: "M4A1", label: "M4A1" }]);
  });

  it("ranks the whole-name match first: m4 → M4A1 before M4_Suppressor", () => {
    expect(itemHits("m4").map((h) => h.className)).toEqual(["M4A1", "M4_Suppressor"]);
  });

  it("matches a word inside a class name, split at underscores and at capitals", () => {
    expect(itemHits("cola").map((h) => h.className)).toEqual(["SodaCan_Cola"]);
    expect(itemHits("can").map((h) => h.className)).toEqual(["TunaCan", "SodaCan_Cola"]);
    expect(itemHits("stanag").map((h) => h.className)).toEqual(["Mag_STANAG_30Rnd"]);
  });

  it("keeps the places beside the items", () => {
    const r = searchMap("no ab", withItems);
    expect(r.hits[0]).toMatchObject({ tab: "locations", label: "No Abad" });
  });

  it("finds no items for a coordinate", () => {
    expect(searchMap("072 087", withItems).hits).toEqual([]);
  });
});

describe("searchMap items with their cards", () => {
  const items = ["M4A1", "M4A1_Green", "AKM", "TunaCan"].map((className) => ({ className }));
  const cards = new Map([
    ["M4A1", { displayName: "M4-A1" }],
    ["M4A1_Green", { displayName: "M4-A1" }],
    ["AKM", { displayName: "KA-M" }],
    ["TunaCan", { displayName: "Canned Tuna" }],
  ]);
  const withCards: SearchCtx = { ...ctx, items, cards };
  const itemHits = (q: string) => searchMap(q, withCards).hits.filter((h) => h.tab === "items");

  it("matches the game's display name: \"M4-A1\" finds M4A1, labelled as the game names it", () => {
    expect(itemHits("M4-A1")).toEqual([
      { tab: "items", className: "M4A1", label: "M4-A1" },
      { tab: "items", className: "M4A1_Green", label: "M4-A1" },
    ]);
  });

  it("still matches the class name: \"akm\" finds the KA-M", () => {
    expect(itemHits("akm").map((h) => h.className)).toEqual(["AKM"]);
  });

  it("finds a word only the display name has", () => {
    expect(itemHits("tuna").map((h) => h.label)).toEqual(["Canned Tuna"]);
    expect(itemHits("canned").map((h) => h.className)).toEqual(["TunaCan"]);
  });

  it("works without the cards: an item with no card keeps its class name", () => {
    const some: SearchCtx = { ...ctx, items, cards: new Map([["AKM", { displayName: "KA-M" }]]) };
    expect(searchMap("m4a1", some).hits.filter((h) => h.tab === "items")[0]).toEqual({ tab: "items", className: "M4A1", label: "M4A1" });
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

  it("shows the Items tab once the item index is in", () => {
    const html = render({ initial: "m4a1", ctx: { ...ctx, items: [{ className: "M4A1" }] } });
    expect(html).toContain(">Items<");
    expect(html).toContain(">M4A1<");
  });

  it("shows an item's class name beside its display name, so two colours of one gun tell apart", () => {
    const html = render({ initial: "m4-a1", ctx: { ...ctx, items: [{ className: "M4A1_Green" }], cards: new Map([["M4A1_Green", { displayName: "M4-A1" }]]) } });
    expect(html).toContain(">M4-A1<");
    expect(html).toContain(">M4A1_Green<");
  });

  it("says the items are loading instead of \"nothing by that name\"", () => {
    const html = render({ initial: "m4a1", itemsStatus: "loading" });
    expect(html).toContain("Loading items…");
    expect(html).not.toContain("Nothing on the map by that name.");
  });

  it("says the items failed, as a retry", () => {
    const html = render({ initial: "m4a1", itemsStatus: "failed" });
    expect(html).toContain("Items could not load. Try again.");
    expect(html).toMatch(/<button[^>]*>Items could not load\. Try again\.<\/button>/);
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

describe("searchMap models", () => {
  const world = JSON.parse(readFileSync(join(__dirname, "..", "public", "map-data", "nasdara", "world.json"), "utf8")) as WorldFile;
  const withModels: SearchCtx = { ...ctx, models: modelCounts(world) };
  const modelHits = (q: string) => searchMap(q, withModels).hits.filter((h) => h.tab === "models");

  it("labels a type without Land_ and with spaces", () => {
    expect(modelLabel("Land_Mil_Barracks1")).toBe("Mil Barracks1");
    expect(modelLabel("Wreck_UH1Y")).toBe("Wreck UH1Y");
  });

  it("finds Mil Barracks1 for \"barracks\" with its placement count", () => {
    const hit = modelHits("barracks").find((h) => h.tab === "models" && h.typeName === "Land_Mil_Barracks1");
    expect(hit).toEqual({ tab: "models", typeName: "Land_Mil_Barracks1", label: "Mil Barracks1", count: 4 });
    expect(modelHits("barracks")).toHaveLength(10);
  });

  it("returns that many points for the type", () => {
    const pts = modelPoints(world, "Land_Mil_Barracks1");
    expect(pts).toHaveLength(4);
    expect(pts[0]).toMatchObject({ title: "Mil Barracks1" });
    expect(modelPoints(world, "Nope")).toEqual([]);
  });

  it("gives every placement of a picked model its own marker id, apart from items'", () => {
    const items = modelItems("Land_Mil_Barracks1", modelPoints(world, "Land_Mil_Barracks1"));
    expect(items.map((i) => i.id)).toEqual([0, 1, 2, 3].map((i) => `model:Land_Mil_Barracks1#${i}`));
    expect(items.every((i) => i.key === "item")).toBe(true);
  });

  it("returns no model hits until the world file is in", () => {
    expect(searchMap("barracks", ctx).hits.some((h) => h.tab === "models")).toBe(false);
  });

  it("shows the Models tab with the count, and picking sends the type", () => {
    const html = renderToStaticMarkup(createElement(MapSearch, { ...base, initial: "barracks1", ctx: withModels }));
    expect(html).toContain(">Models<");
    expect(html).toContain(">Mil Barracks1<");
    expect(html).toContain(">4<");
  });
});
