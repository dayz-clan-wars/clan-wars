import { describe, it, expect } from "vitest";
import { pointsFor, weekStartOf } from "../src/scoring";
import { POINTS_BOTTOM, POINTS_TOP, POINTS_UNRANKED } from "../src/rules";

describe("pointsFor (spec §8.1)", () => {
  it("gives the top clan POINTS_TOP and the bottom POINTS_BOTTOM", () => {
    expect(pointsFor(1, 10)).toBe(POINTS_TOP);
    expect(pointsFor(10, 10)).toBe(POINTS_BOTTOM);
  });
  it("the guide's worked example: N = 10, r = 4 → 167", () => {
    expect(pointsFor(4, 10)).toBe(167);
  });
  it("a lone ranked clan is worth POINTS_TOP; an unranked victim POINTS_UNRANKED", () => {
    expect(pointsFor(1, 1)).toBe(POINTS_TOP);
    expect(pointsFor(null, 7)).toBe(POINTS_UNRANKED);
    expect(pointsFor(null, 0)).toBe(POINTS_UNRANKED);
  });
});

describe("weekStartOf", () => {
  it("is Monday 00:00 UTC of the same week", () => {
    expect(weekStartOf(new Date("2026-09-05T13:00:00Z")).toISOString()).toBe("2026-08-31T00:00:00.000Z"); // a Saturday
    expect(weekStartOf(new Date("2026-08-31T00:00:00Z")).toISOString()).toBe("2026-08-31T00:00:00.000Z"); // Monday itself
    expect(weekStartOf(new Date("2026-09-06T23:59:59Z")).toISOString()).toBe("2026-08-31T00:00:00.000Z"); // Sunday night
  });
});
