import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parseState, type WireState } from "../app/(site)/map/map-draw";
import { DATA_LAYERS, changedLayers, layerSignatures, reopenAfter } from "../app/(site)/map/map-redraw";
import { markerKey } from "../lib/map-roster";

const WIRE: WireState = {
  world: { size: 12800 },
  you: { gamertag: "Me", fix: { x: 1000, z: 2000, at: "2026-09-24T11:00:00Z" } },
  base: null,
  clanmates: [{ dayzId: "a", gamertag: "Bob", fix: { x: 1500, z: 2500, at: "2026-09-24T11:30:00Z" } }],
  intruders: [],
  publicBases: [{ x: 3000, z: 3000 }],
  pins: [{ id: 7, x: 4000, z: 4000, icon: "loot", note: "crate", by: "Bob", at: "2026-09-24T10:00:00Z", expiresAt: "2026-10-01T10:00:00Z" }],
  bounties: [],
  travelPoints: [{ x: 5000, z: 5000 }],
  hub: { x: 6000, z: 6000 },
  layers: { base: false, clanmates: true, intruders: false, pins: true },
};
const first = layerSignatures(parseState(WIRE), false);

describe("changedLayers", () => {
  it("draws every data layer the first time", () => {
    expect(changedLayers({}, first)).toEqual([...DATA_LAYERS]);
  });

  /**
   * ⚠️ Review focus 1. Every poll used to clear every group, and Leaflet
   * closes the popup of a removed marker: a player halfway through the
   * two-tap Delete lost the card and the armed button every five minutes.
   */
  it("a poll that moves only a clanmate leaves the pins layer — and an open, armed pin popup — alone", () => {
    const moved = { ...WIRE, clanmates: [{ ...WIRE.clanmates[0]!, fix: { x: 1600, z: 2600, at: "2026-09-24T11:35:00Z" } }] };
    const changed = changedLayers(first, layerSignatures(parseState(moved), false));
    expect(changed).toEqual(["clanmates"]);
    expect(reopenAfter(markerKey.pin(7), changed)).toBeNull();
  });

  it("never rebuilds the 209 travel points once drawn", () => {
    const again = layerSignatures(parseState({ ...WIRE, clanmates: [] }), false);
    expect(changedLayers(first, again)).not.toContain("travel");
  });

  it("redraws the 'you' group when the hint's ring comes or goes", () => {
    expect(changedLayers(first, layerSignatures(parseState(WIRE), true))).toEqual(["you"]);
  });
});

describe("reopenAfter", () => {
  it("puts a popup back when its own layer was rebuilt — its marker is new", () => {
    expect(reopenAfter(markerKey.pin(7), ["pins"])).toBe("pin:7");
    expect(reopenAfter(markerKey.clanmate("a"), ["clanmates", "pins"])).toBe("clanmate:a");
  });

  it("does nothing with no popup open, or an unknown key", () => {
    expect(reopenAfter(null, ["pins"])).toBeNull();
    expect(reopenAfter("__proto__", ["pins"])).toBeNull();
  });
});

describe("map-view.tsx redraws only what changed", () => {
  const view = readFileSync(join(import.meta.dirname, "..", "app", "(site)", "map", "map-view.tsx"), "utf8");

  it("clears only the changed groups, never every group", () => {
    expect(view).toContain("for (const key of changed) {");
    expect(view).not.toMatch(/for \(const key of ALL_KEYS\) \{\s*if \(key === "terrain" \|\| key === "places"\) continue;\s*groups\.current\[key\]!\.clearLayers\(\)/u);
  });

  it("skips an answer whose body is byte-for-byte the last one", () => {
    expect(view).toContain("body !== lastBody.current");
  });
});
