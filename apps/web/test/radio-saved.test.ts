import { describe, it, expect } from "vitest";
import { KEEP_MS, loadReads, saveReads } from "../lib/radio/saved";

function memory() {
  const m = new Map<string, string>();
  return {
    m,
    getItem: (k: string) => m.get(k) ?? null,
    setItem: (k: string, v: string) => void m.set(k, v),
    removeItem: (k: string) => void m.delete(k),
  };
}

describe("kept radio reads", () => {
  it("come back as they were saved", () => {
    const s = memory();
    saveReads(s, [{ digits: "0910442410" }, { digits: "09?0442410" }], 1000);
    expect(loadReads(s, 2000)).toEqual([{ digits: "0910442410" }, { digits: "09?0442410" }]);
  });

  it("are dropped two hours after the last save", () => {
    const s = memory();
    saveReads(s, [{ digits: "0910442410" }], 0);
    expect(loadReads(s, KEEP_MS)).toHaveLength(1);
    expect(loadReads(s, KEEP_MS + 1)).toEqual([]);
    expect(s.m.size).toBe(0);
  });

  it("saving none removes the entry", () => {
    const s = memory();
    saveReads(s, [{ digits: "0910442410" }], 0);
    saveReads(s, [], 1);
    expect(s.m.size).toBe(0);
  });

  it("ignores junk rather than showing it", () => {
    const s = memory();
    s.setItem("clan-wars:radio-reads:v1", "not json");
    expect(loadReads(s, 0)).toEqual([]);
    s.setItem("clan-wars:radio-reads:v1", JSON.stringify({ savedAt: 0, reads: ["0910442410", "short", 7, "abcdefghij"] }));
    expect(loadReads(s, 0)).toEqual([{ digits: "0910442410" }]);
  });

  it("a store that throws keeps nothing and breaks nothing", () => {
    const bad = { getItem: () => { throw new Error("x"); }, setItem: () => { throw new Error("x"); }, removeItem: () => { throw new Error("x"); } };
    expect(() => saveReads(bad, [{ digits: "0910442410" }], 0)).not.toThrow();
    expect(loadReads(bad, 0)).toEqual([]);
    expect(loadReads(null, 0)).toEqual([]);
  });
});
