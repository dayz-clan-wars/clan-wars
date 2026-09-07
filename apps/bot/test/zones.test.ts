import { describe, it, expect } from "vitest";
import { zoneContaining, type Zone } from "../src/zones.js";
import { WATCH_ZONE_RADIUS_M } from "@factions/domain";

// ⚠️ Asymmetric on purpose (x !== z): a fixture on the diagonal (x === z)
// cannot distinguish a correct 2-D distance from one that swaps x and z
// internally — both give the same answer either way.
const clan: Zone = { declarationId: 1, x: 5000, z: 3000, ownerFactionId: 7, ownerDayzId: null, fullMemberIds: new Set(["M".repeat(40)]) };
const solo: Zone = { declarationId: 2, x: 8000, z: 8000, ownerFactionId: null, ownerDayzId: "S".repeat(40), fullMemberIds: new Set() };

describe("zoneContaining", () => {
  it("finds the zone within WATCH_ZONE_RADIUS_M, 2-D, with the whole-metre distance", () => {
    expect(zoneContaining([clan, solo], { x: 5000 + WATCH_ZONE_RADIUS_M - 0.5, z: 3000 })).toEqual({ zone: clan, distanceM: 100 });
    expect(zoneContaining([clan, solo], { x: 5000 + WATCH_ZONE_RADIUS_M + 0.5, z: 3000 })).toBeNull();
  });
  it("⚠️ compares x with x and z with z", () => {
    // Swapping x and z from the zone's centre lands 50 m from the zone on the
    // z axis: a correct comparison hits (x matches exactly, z is 50 off);
    // a swapped one would compare this fix's x against the zone's z instead.
    expect(zoneContaining([clan], { x: 5000, z: 3000 + 50 })).toEqual({ zone: clan, distanceM: 50 });
    // The mirror image: this fix's (x, z) equal the zone's (z, x) — a x/z
    // swap bug would compute zero distance and report a hit; comparing the
    // right axes puts it thousands of metres away.
    expect(zoneContaining([clan], { x: 3000, z: 5000 })).toBeNull();
  });
});
