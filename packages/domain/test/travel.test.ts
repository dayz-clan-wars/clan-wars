import { describe, it, expect } from "vitest";
import { FAST_TRAVEL_POINTS, FAST_TRAVEL_HUB, HUB_POSITION, TRAVEL_POINTS } from "../src/index";

describe("fast travel points", () => {
  it("counts exactly TRAVEL_POINTS, the number the guide promises", () => {
    expect(FAST_TRAVEL_POINTS).toHaveLength(TRAVEL_POINTS);
  });
  it("puts the Hub where rules.ts says it is", () => {
    expect(FAST_TRAVEL_HUB).toEqual(HUB_POSITION);
  });
  it("keeps every point inside Livonia (12800 m)", () => {
    for (const p of FAST_TRAVEL_POINTS) { expect(p.x).toBeGreaterThanOrEqual(0); expect(p.x).toBeLessThanOrEqual(12800); expect(p.z).toBeGreaterThanOrEqual(0); expect(p.z).toBeLessThanOrEqual(12800); }
  });
});
