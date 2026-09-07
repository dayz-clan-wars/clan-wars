import { describe, it, expect } from "vitest";
import { zoneContaining, type Zone } from "../src/zones.js";
import { WATCH_ZONE_RADIUS_M } from "@factions/domain";

const clan: Zone = { declarationId: 1, x: 5000, z: 5000, ownerFactionId: 7, ownerDayzId: null, fullMemberIds: new Set(["M".repeat(40)]) };
const solo: Zone = { declarationId: 2, x: 8000, z: 8000, ownerFactionId: null, ownerDayzId: "S".repeat(40), fullMemberIds: new Set() };

describe("zoneContaining", () => {
  it("finds the zone within WATCH_ZONE_RADIUS_M, 2-D, with the whole-metre distance", () => {
    expect(zoneContaining([clan, solo], { x: 5000 + WATCH_ZONE_RADIUS_M - 0.5, z: 5000 })).toEqual({ zone: clan, distanceM: 100 });
    expect(zoneContaining([clan, solo], { x: 5000 + WATCH_ZONE_RADIUS_M + 0.5, z: 5000 })).toBeNull();
  });
  it("⚠️ compares x with x and z with z", () => {
    expect(zoneContaining([clan], { x: 5000, z: 6000 })).toBeNull();
  });
});
