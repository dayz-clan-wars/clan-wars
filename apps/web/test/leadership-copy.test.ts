import { describe, it, expect } from "vitest";
import { LEADERSHIP_RESULT_COPY, leadershipCode } from "../lib/leadership-copy";

describe("leadership result copy", () => {
  it("has a non-empty sentence for every code", () => {
    for (const [k, v] of Object.entries(LEADERSHIP_RESULT_COPY)) {
      expect(k, k).toMatch(/^[a-z-]+\.[a-z-]+$/u);
      expect(v.trim().length, k).toBeGreaterThan(0);
    }
  });
  it("builds keys the table has", () => {
    expect(LEADERSHIP_RESULT_COPY[leadershipCode("claim-succession", "claim-open")]).toBeDefined();
    expect(LEADERSHIP_RESULT_COPY[leadershipCode("open-vote", "cooldown")]).toBeDefined();
    expect(LEADERSHIP_RESULT_COPY[leadershipCode("cast-vote", "not-in-electorate")]).toBeDefined();
  });
  it("misses on a prototype key", () => {
    expect(Object.hasOwn(LEADERSHIP_RESULT_COPY, "__proto__")).toBe(false);
  });
  it("never says faction", () => {
    for (const [k, v] of Object.entries(LEADERSHIP_RESULT_COPY)) {
      expect(v, k).not.toMatch(/faction/iu);
    }
  });
});
