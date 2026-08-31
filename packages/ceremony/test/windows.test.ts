import { describe, it, expect } from "vitest";
import {
  settleWindows, qualifies, CEREMONY_WINDOW_MS, MIN_PARTICIPANTS,
  type QualifyingRaise,
} from "../src/windows.js";

const T0 = new Date("2026-08-31T12:00:00Z");
const at = (mins: number) => new Date(T0.getTime() + mins * 60_000);
let nextId = 1;
const raise = (dayzId: string, mins: number): QualifyingRaise =>
  ({ eventId: nextId++, dayzId, gamertag: dayzId.slice(0, 4), occurredAt: at(mins) });

describe("settleWindows", () => {
  it("settles a window once the log has advanced past its end", () => {
    const raises = [raise("A", 0), raise("B", 1), raise("C", 2)];
    const [w] = settleWindows(raises, at(11));
    expect(w?.participants.sort()).toEqual(["A", "B", "C"]);
    expect(qualifies(w!)).toBe(true);
  });

  it("does NOT settle while the high-water mark is inside the window", () => {
    // The participant set is not knowable yet: more raises may still arrive
    // in this window, and settling now would silently exclude them.
    const raises = [raise("A", 0), raise("B", 1), raise("C", 2)];
    expect(settleWindows(raises, at(5))).toEqual([]);
  });

  it("includes a fourth participant who arrives at minute nine", () => {
    // The reason windows settle rather than firing on the third raise. A
    // founding member excluded here can never be added: the claim step only
    // prunes.
    const raises = [raise("A", 0), raise("B", 1), raise("C", 2), raise("D", 9)];
    const [w] = settleWindows(raises, at(11));
    expect(w?.participants.sort()).toEqual(["A", "B", "C", "D"]);
  });

  it("counts distinct UIDs, not raises", () => {
    const raises = [raise("A", 0), raise("A", 1), raise("A", 2)];
    const [w] = settleWindows(raises, at(11));
    expect(w?.participants).toEqual(["A"]);
    expect(qualifies(w!)).toBe(false);
  });

  it("anchors the next window at the oldest unconsumed raise, not a slide", () => {
    // 0, 5, 11 is TWO windows (0-10, 11-21), not one. A sliding window would
    // let a slow trickle at a busy pole accumulate into a ceremony nobody
    // performed.
    const raises = [raise("A", 0), raise("B", 5), raise("C", 11)];
    const windows = settleWindows(raises, at(30));
    expect(windows).toHaveLength(2);
    expect(windows[0]!.participants.sort()).toEqual(["A", "B"]);
    expect(windows[1]!.participants).toEqual(["C"]);
    // Wrap qualifies in arrow to avoid Array.some passing array index as min parameter
    expect(windows.some((w) => qualifies(w))).toBe(false);
  });

  it("excludes a raise landing exactly on the window end", () => {
    // Half-open [start, start+10m). The boundary raise anchors the next
    // window instead — otherwise the window's own length is ambiguous.
    const raises = [raise("A", 0), raise("B", 1), raise("C", 10)];
    const windows = settleWindows(raises, at(30));
    expect(windows[0]!.participants.sort()).toEqual(["A", "B"]);
    expect(windows[1]!.participants).toEqual(["C"]);
  });

  it("settles earlier windows even when a later one is still open", () => {
    const raises = [raise("A", 0), raise("B", 1), raise("C", 2), raise("D", 25)];
    const windows = settleWindows(raises, at(30));
    expect(windows).toHaveLength(1);
    expect(windows[0]!.participants.sort()).toEqual(["A", "B", "C"]);
  });

  it("orders by event id when two raises share a timestamp", () => {
    // ADM has second granularity, so ties are ordinary, not exotic. Ordering
    // must be total or window anchoring is nondeterministic.
    const a = { eventId: 90, dayzId: "B", gamertag: "B", occurredAt: at(0) };
    const b = { eventId: 80, dayzId: "A", gamertag: "A", occurredAt: at(0) };
    const [w] = settleWindows([a, b], at(11));
    expect(w?.raises.map((r) => r.eventId)).toEqual([80, 90]);
  });

  it("returns nothing for no raises", () => {
    expect(settleWindows([], at(99))).toEqual([]);
  });

  it("uses a ten-minute window and a three-participant floor", () => {
    expect(CEREMONY_WINDOW_MS).toBe(600_000);
    expect(MIN_PARTICIPANTS).toBe(3);
  });
});
