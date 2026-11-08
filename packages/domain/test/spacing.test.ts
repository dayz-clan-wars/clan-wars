import { describe, it, expect } from "vitest";
import { distance2d, tooClose, nearMapEdge, HUB_POSITION, MIN_BASE_SPACING_M, MAP_EDGE_BUFFER_M, WORLD_SIZE_M } from "../src/index.js";

describe("distance2d", () => {
  it("is planar on x and z, ignoring altitude", () => {
    expect(distance2d({ x: 0, z: 0 }, { x: 3, z: 4 })).toBe(5);
  });
});

describe("tooClose", () => {
  const far = { x: 5000, z: 5000 };

  it("accepts a pole with nothing within 200 m", () => {
    expect(tooClose(far, [{ x: 5300, z: 5000 }])).toBeNull();
  });

  it("refuses a pole 199.99 m from another declaration", () => {
    expect(tooClose(far, [{ x: 5199.99, z: 5000 }])).toEqual({ x: 5199.99, z: 5000 });
  });

  it("accepts exactly 200 m — the rule is strictly less than", () => {
    expect(tooClose(far, [{ x: 5200, z: 5000 }])).toBeNull();
  });

  it("⚠️ treats the Fast Travel Hub as a declaration that always exists", () => {
    const nearHub = { x: HUB_POSITION.x + 50, z: HUB_POSITION.z };
    expect(tooClose(nearHub, [])).toEqual({ x: HUB_POSITION.x, z: HUB_POSITION.z });
  });

  it("uses MIN_BASE_SPACING_M by default", () => {
    expect(tooClose(far, [{ x: far.x + MIN_BASE_SPACING_M - 1, z: far.z }])).not.toBeNull();
  });
});

describe("nearMapEdge", () => {
  it("allows the middle of the map", () => {
    expect(nearMapEdge({ x: WORLD_SIZE_M / 2, z: WORLD_SIZE_M / 2 })).toBe(false);
  });

  it("refuses inside the buffer on every side", () => {
    const mid = WORLD_SIZE_M / 2;
    const inside = MAP_EDGE_BUFFER_M - 0.01;
    expect(nearMapEdge({ x: inside, z: mid })).toBe(true);
    expect(nearMapEdge({ x: WORLD_SIZE_M - inside, z: mid })).toBe(true);
    expect(nearMapEdge({ x: mid, z: inside })).toBe(true);
    expect(nearMapEdge({ x: mid, z: WORLD_SIZE_M - inside })).toBe(true);
  });

  it("allows exactly the buffer — the rule is strictly less than", () => {
    expect(nearMapEdge({ x: MAP_EDGE_BUFFER_M, z: MAP_EDGE_BUFFER_M })).toBe(false);
    expect(nearMapEdge({ x: WORLD_SIZE_M - MAP_EDGE_BUFFER_M, z: WORLD_SIZE_M - MAP_EDGE_BUFFER_M })).toBe(false);
  });

  it("is 1 km on a 16384 m map", () => {
    expect(MAP_EDGE_BUFFER_M).toBe(1000);
    expect(WORLD_SIZE_M).toBe(16384);
  });
});
