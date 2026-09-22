import { describe, it, expect } from "vitest";
import {
  AIRDROP_COLOURS, AIRDROP_LOCATIONS, AIRDROP_MIN_GAP_MS, AIRDROP_NO_REPEAT,
  airdropSpawnerPath, chooseAirdrop, decisionInstantFor, highWater, isoWeekStart, shouldFire,
} from "../src/airdrops";

const at = (iso: string) => new Date(iso);
const fire = (over: Partial<Parameters<typeof shouldFire>[0]> = {}) => shouldFire({
  pop: 6, threshold: 5, minPop: 5, weekCount: 0, weeklyCap: 2,
  lastFireAt: null, openEvent: false, now: at("2026-09-21T19:30:00Z"), ...over,
});

describe("the menu", () => {
  it("is the 16 staged locations and 3 colours, and nothing else", () => {
    expect(AIRDROP_LOCATIONS).toHaveLength(16);
    expect(AIRDROP_COLOURS).toEqual(["blue", "orange", "yellow"]);
  });

  // ⚠️ location THEN colour. The spec's first draft had them the other way round,
  // which names 48 files that do not exist — and the miss is silent: the file is
  // registered, the server boots, and no container ever spawns.
  it("names the spawner file location-then-colour", () => {
    expect(airdropSpawnerPath({ location: "dolnik", colour: "blue" }))
      .toBe("./custom/airdrop-dolnik-blue.json");
  });
});

describe("chooseAirdrop", () => {
  it("never repeats a location inside the no-repeat window", () => {
    const recent = AIRDROP_LOCATIONS.slice(0, AIRDROP_NO_REPEAT);
    for (let i = 0; i < 200; i++) {
      const spec = chooseAirdrop([...recent], () => i / 200);
      expect(recent).not.toContain(spec.location);
      expect(AIRDROP_COLOURS).toContain(spec.colour);
    }
  });

  // ⚠️ A window longer than the menu would otherwise empty the pool and throw on
  // an undefined index — a crash in the one tick that is supposed to be optional.
  it("falls back to the full menu rather than emptying the pool", () => {
    const spec = chooseAirdrop([...AIRDROP_LOCATIONS], () => 0);
    expect(AIRDROP_LOCATIONS).toContain(spec.location);
  });
});

describe("highWater", () => {
  it("is the peak, and is 0 on no history", () => {
    // ⚠️ 0 on no history is load-bearing, not a convenience: it leaves
    // `max(AIRDROP_MIN_POP, 0)` at the floor, which is the right bar on day one
    // and through the first five days. Returning -Infinity (the naive Math.max
    // of an empty list) would leave the floor governing too, but any later
    // arithmetic on the recorded threshold would be poisoned by it.
    expect(highWater([])).toBe(0);
    expect(highWater([1, 1, 1, 1, 1, 1, 1, 1, 1, 10])).toBe(10);
    expect(highWater([5])).toBe(5);
    // ⚠️ One outlier sets the bar for the whole window. This is the accepted
    // cost of the high-water rule (2026-09-21) — see the design's §3.1.
    expect(highWater([2, 2, 11, 3, 2])).toBe(11);
  });
});

describe("shouldFire", () => {
  it("fires at a real peak", () => expect(fire()).toBe(true));
  it("holds the floor when the high-water mark has collapsed", () =>
    expect(fire({ pop: 3, threshold: 2 })).toBe(false));
  it("holds the high-water mark once the server has grown past the floor", () =>
    expect(fire({ pop: 6, threshold: 8 })).toBe(false));
  // ⚠️ A TIE fires. The rule is "at or above the high point", so equalling the
  // five-day record is a peak — if this flipped to a strict `>`, the record could
  // only ever be beaten, and a server sitting at a stable ceiling would never
  // drop again.
  it("fires on a tie with the high-water mark", () =>
    expect(fire({ pop: 9, threshold: 9 })).toBe(true));
  // ⚠️ §3.2: a cap, never a quota. A quiet week gets zero drops, on purpose.
  it("refuses once the week's cap is spent", () =>
    expect(fire({ weekCount: 2 })).toBe(false));
  it("refuses inside the 24h gap and allows just outside it", () => {
    expect(fire({ lastFireAt: at("2026-09-21T02:00:00Z") })).toBe(false);
    expect(fire({ lastFireAt: new Date(at("2026-09-21T19:30:00Z").getTime() - AIRDROP_MIN_GAP_MS - 1) })).toBe(true);
  });
  it("refuses while another drop is announced or live", () =>
    expect(fire({ openEvent: true })).toBe(false));
});

describe("the calendar", () => {
  it("starts the ISO week on Monday 00:00 UTC", () => {
    expect(isoWeekStart(at("2026-09-21T19:30:00Z")).toISOString()).toBe("2026-09-21T00:00:00.000Z");
    expect(isoWeekStart(at("2026-09-20T23:59:59Z")).toISOString()).toBe("2026-09-14T00:00:00.000Z");
  });
  it("puts the decision 30 minutes before the slot", () => {
    expect(decisionInstantFor(at("2026-09-21T20:00:00Z")).toISOString()).toBe("2026-09-21T19:30:00.000Z");
  });
});
