import { describe, it, expect } from "vitest";
import { clockOffsetMsFor, CLOCK_OFFSET_MS_BY_MAP } from "../src/clock-offsets.js";

describe("clockOffsetMsFor", () => {
  it("returns the measured offset for each known map", () => {
    expect(clockOffsetMsFor("chernarus")).toBe(4 * 60 * 60 * 1000);
    expect(clockOffsetMsFor("livonia")).toBe(7 * 60 * 60 * 1000);
    expect(clockOffsetMsFor("sakhal")).toBe(7 * 60 * 60 * 1000);
  });

  it("throws on an unknown map rather than defaulting to a zero offset", () => {
    // This is the exact failure the offset table exists to prevent: a silent 0
    // stores every timestamp for that server hours wrong while every
    // count-based acceptance check stays green.
    expect(() => clockOffsetMsFor("namalsk")).toThrow();
  });

  it("names the offending map in the error message", () => {
    expect(() => clockOffsetMsFor("namalsk")).toThrow(/namalsk/);
  });

  it("lists the known maps in the error message", () => {
    for (const map of Object.keys(CLOCK_OFFSET_MS_BY_MAP)) {
      expect(() => clockOffsetMsFor("namalsk")).toThrow(new RegExp(map));
    }
  });

  it("does not treat a prototype key as a configured map", () => {
    expect(() => clockOffsetMsFor("constructor")).toThrow(/constructor/);
  });
});
