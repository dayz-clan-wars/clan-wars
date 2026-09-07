import { describe, it, expect } from "vitest";
import { parseSeasonParam } from "../lib/stat-scope";

describe("parseSeasonParam", () => {
  it("is 'default' when absent", () => {
    expect(parseSeasonParam(undefined)).toBe("default");
  });

  it("is all-time for 'all'", () => {
    expect(parseSeasonParam("all")).toEqual({ kind: "all" });
  });

  it("is a season for a positive integer", () => {
    expect(parseSeasonParam("3")).toEqual({ kind: "season", number: 3 });
    expect(parseSeasonParam("1")).toEqual({ kind: "season", number: 1 });
  });

  it("falls back to 'default' for zero, negative, non-integer, or garbage", () => {
    expect(parseSeasonParam("0")).toBe("default");
    expect(parseSeasonParam("-1")).toBe("default");
    expect(parseSeasonParam("1.5")).toBe("default");
    expect(parseSeasonParam("abc")).toBe("default");
    expect(parseSeasonParam("")).toBe("default");
    expect(parseSeasonParam("3abc")).toBe("default");
  });

  it("falls back to 'default' for an array value (repeated query key)", () => {
    expect(parseSeasonParam(["3", "4"])).toBe("default");
  });

  it("never echoes the raw value back", () => {
    const raw = "__proto__";
    const parsed = parseSeasonParam(raw);
    expect(parsed).toBe("default");
  });
});
