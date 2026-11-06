import { describe, it, expect } from "vitest";
import { weekStartOf } from "../src/scoring";

describe("weekStartOf", () => {
  it("is Monday 00:00 UTC of the same week", () => {
    expect(weekStartOf(new Date("2026-09-05T13:00:00Z")).toISOString()).toBe("2026-08-31T00:00:00.000Z"); // a Saturday
    expect(weekStartOf(new Date("2026-08-31T00:00:00Z")).toISOString()).toBe("2026-08-31T00:00:00.000Z"); // Monday itself
    expect(weekStartOf(new Date("2026-09-06T23:59:59Z")).toISOString()).toBe("2026-08-31T00:00:00.000Z"); // Sunday night
  });
});
