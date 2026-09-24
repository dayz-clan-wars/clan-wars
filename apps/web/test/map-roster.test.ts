import { describe, it, expect } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { layerOfKey, markerKey, rosterRows, type RosterInput } from "../lib/map-roster";
import { ROSTER_COPY } from "../lib/map-copy";
import { MapRoster } from "../app/(site)/map/map-roster";

const now = new Date("2026-09-24T12:00:00Z");
const ago = (min: number) => new Date(now.getTime() - min * 60_000);
const DATA: RosterInput = {
  you: { fix: { x: 4321.7, z: 8765.2, at: ago(14) } },
  base: { x: 4400.4, z: 8800.9 },
  clanmates: [
    { dayzId: "a", gamertag: "Older", fix: { x: 1234.5, z: 2345.6, at: ago(300) } },
    { dayzId: "b", gamertag: "Newer", fix: { x: 3456.7, z: 4567.8, at: ago(5) } },
  ],
  intruders: [{ gamertag: "Stranger", x: 4410.1, z: 8790.3, lastSeenAt: ago(2), distanceM: 42.4 }],
  bounties: [{ gamertag: "Hunted", fix: { x: 5678.9, z: 6789.1, at: ago(1) } }],
  pins: [{ id: 7, x: 6111.1, z: 7222.2, icon: "loot", by: "Newer", at: ago(60) }],
};
const ALL = { you: true, base: true, clanmates: true, intruders: true, bounties: true, pins: true };
/** Every metre value above, as it would appear if one leaked. */
const METRES = ["4321", "8765", "4400", "8800", "1234", "2345", "3456", "4567", "4410", "8790", "5678", "6789", "6111", "7222"];

describe("rosterRows", () => {
  it("lists you, your base, intruders, bounties, clanmates (newest first), then pins", () => {
    expect(rosterRows(DATA, ALL, now)).toEqual([
      { key: "you", name: "You", detail: "grid 043 087 · 14 min ago" },
      { key: "base", name: "Your base", detail: "grid 044 088" },
      { key: "intruder:Stranger", name: "Stranger", detail: "Intruder, 42 m · grid 044 087 · 2 min ago" },
      { key: "bounty:Hunted", name: "Hunted", detail: "Wanted · grid 056 067 · 1 min ago" },
      { key: "clanmate:b", name: "Newer", detail: "Clanmate · grid 034 045 · 5 min ago" },
      { key: "clanmate:a", name: "Older", detail: "Clanmate · grid 012 023 · 5 h ago" },
      { key: "pin:7", name: "Loot pin", detail: "by Newer · grid 061 072 · 1 h ago" },
    ]);
  });

  it("leaves out a layer that is switched off — its marker is not on the map to open", () => {
    const rows = rosterRows(DATA, { ...ALL, clanmates: false }, now);
    expect(rows.some((r) => r.key.startsWith("clanmate:"))).toBe(false);
  });

  /** ⚠️ Review focus 5: grid refs only, in the rows and in what renders. */
  it("carries no metre coordinate, in the rows or the rendered list", () => {
    const rows = rosterRows(DATA, ALL, now);
    const html = renderToStaticMarkup(createElement(MapRoster, { rows, onGo: () => {} }));
    for (const m of METRES) {
      expect(JSON.stringify(rows)).not.toContain(m);
      expect(html).not.toContain(m);
    }
  });
});

describe("markerKey and layerOfKey", () => {
  it("round-trips every kind to the layer that draws it", () => {
    expect(layerOfKey(markerKey.you())).toBe("you");
    expect(layerOfKey(markerKey.base())).toBe("base");
    expect(layerOfKey(markerKey.clanmate("b"))).toBe("clanmates");
    expect(layerOfKey(markerKey.intruder("Stranger"))).toBe("intruders");
    expect(layerOfKey(markerKey.bounty("Hunted"))).toBe("bounties");
    expect(layerOfKey(markerKey.pin(7))).toBe("pins");
  });

  it("answers null for anything else, prototype keys included", () => {
    expect(layerOfKey("__proto__")).toBeNull();
    expect(layerOfKey("travel:1")).toBeNull();
  });
});

describe("MapRoster", () => {
  it("renders one 44px button a row under an 'On the map' heading", () => {
    const rows = rosterRows(DATA, ALL, now);
    const html = renderToStaticMarkup(createElement(MapRoster, { rows, onGo: () => {} }));
    expect(html).toContain(ROSTER_COPY.heading);
    expect(html.match(/<button/gu)).toHaveLength(rows.length);
    expect(html).toContain("min-h-[44px]");
    expect(html).toContain("Clanmate · grid 034 045 · 5 min ago");
  });

  it("says so when there is nothing to list", () => {
    const html = renderToStaticMarkup(createElement(MapRoster, { rows: [], onGo: () => {} }));
    expect(html).toContain(ROSTER_COPY.empty);
    expect(html).not.toContain("<button");
  });
});

/**
 * On a phone the roster sits inside the bottom sheet, which already scrolls
 * (max-h-[45dvh]). A second scroller inside it trapped a swipe: the list
 * scrolled, the sheet did not, and the legend below the list was unreachable
 * on a short screen. The desktop aside keeps the list's own scroll.
 */
describe("MapRoster's scrolling", () => {
  const rows = rosterRows(DATA, ALL, now);
  it("scrolls on its own by default (the desktop aside)", () => {
    const html = renderToStaticMarkup(createElement(MapRoster, { rows, onGo: () => {} }));
    expect(html).toContain("overflow-y-auto");
  });

  it("leaves scrolling to the sheet when nested in one", () => {
    const html = renderToStaticMarkup(createElement(MapRoster, { rows, onGo: () => {}, nested: true }));
    expect(html).not.toContain("overflow-y-auto");
    expect(html).not.toContain("max-h-");
  });

  it("is nested in the phone sheet", async () => {
    const { readFileSync } = await import("node:fs");
    const { join } = await import("node:path");
    const view = readFileSync(join(import.meta.dirname, "..", "app", "(site)", "map", "map-view.tsx"), "utf8");
    expect(view.match(/<MapRoster rows=\{rows\} onGo=\{goTo\} nested \/>/gu)).toHaveLength(1);
  });
});
