import { describe, it, expect } from "vitest";
import { withoutResult } from "../lib/map-url";

describe("withoutResult", () => {
  it("drops ?result and keeps the grid square", () => {
    expect(withoutResult("https://dayzclanwars.com/map?result=dropped&at=043087")).toBe("/map?at=043087");
  });

  it("leaves a bare path bare", () => {
    expect(withoutResult("https://dayzclanwars.com/map?result=deleted")).toBe("/map");
    expect(withoutResult("https://dayzclanwars.com/map")).toBe("/map");
  });
});
