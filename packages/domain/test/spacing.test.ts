import { describe, it, expect } from "vitest";
import { distance2d, tooClose, HUB_POSITION, MIN_BASE_SPACING_M } from "../src/index.js";

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
