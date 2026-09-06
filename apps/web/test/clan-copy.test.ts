import { describe, it, expect } from "vitest";
import { RESULT_COPY, code, DISBAND_WARNING } from "../lib/clan-copy";

describe("clan result copy", () => {
  it("the disband confirmation says the clan's channels and their history are deleted (spec §14)", () => {
    expect(DISBAND_WARNING).toMatch(/channels? .* deleted/iu);
    expect(DISBAND_WARNING).toMatch(/history/iu);
  });
  it("has a non-empty sentence for every code", () => {
    for (const [k, v] of Object.entries(RESULT_COPY)) {
      expect(k, k).toMatch(/^[a-z-]+\.[a-z-]+$/u);
      expect(v.trim().length, k).toBeGreaterThan(0);
    }
  });
  it("builds keys the table has", () => {
    expect(RESULT_COPY[code("invite", "cap")]).toBeDefined();
    expect(RESULT_COPY[code("claim", "too-close")]).toBeDefined();
  });
  it("misses on a prototype key", () => {
    expect(Object.hasOwn(RESULT_COPY, "__proto__")).toBe(false);
  });
});
