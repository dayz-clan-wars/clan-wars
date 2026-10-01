import { describe, it, expect } from "vitest";
import { mergePoll, type LiveItem } from "../lib/live-items";

const item = (id: number): LiveItem => ({ id, at: "2026-09-30T00:00:00.000Z", title: null, href: null, lines: [], detail: [], flag: null, badge: null, tone: "plain" });
const ids = (xs: LiveItem[]) => xs.map((i) => i.id);

describe("mergePoll", () => {
  it("puts a short poll's entries on top of the list", () => {
    const r = mergePoll([item(5), item(4)], [item(7), item(6)], 50);
    expect(r.reset).toBe(false);
    expect(ids(r.items)).toEqual([7, 6, 5, 4]);
  });
  it("drops entries already on screen", () => {
    const r = mergePoll([item(5), item(4)], [item(6), item(5)], 50);
    expect(r.reset).toBe(false);
    expect(ids(r.items)).toEqual([6, 5, 4]);
  });
  it("⚠️ a full page may have skipped rows below it: it replaces the list instead of leaving a gap", () => {
    const r = mergePoll([item(5), item(4)], [item(103), item(102), item(101)], 3);
    expect(r.reset).toBe(true);
    expect(ids(r.items)).toEqual([103, 102, 101]);
  });
});
