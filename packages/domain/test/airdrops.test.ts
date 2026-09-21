import { describe, it, expect } from "vitest";
import {
  AIRDROP_COLOURS, AIRDROP_LOCATIONS, AIRDROP_MIN_GAP_MS, AIRDROP_NO_REPEAT,
  airdropSpawnerPath, chooseAirdrop, decisionInstantFor, isoWeekStart, p90, shouldFire,
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

describe("p90", () => {
  it("interpolates, and is 0 on no history", () => {
    expect(p90([])).toBe(0);
    expect(p90([1, 1, 1, 1, 1, 1, 1, 1, 1, 10])).toBeCloseTo(1.9, 5);
    expect(p90([5])).toBe(5);
  });
});

describe("shouldFire", () => {
  it("fires at a real peak", () => expect(fire()).toBe(true));
  it("holds the floor when the percentile has collapsed", () =>
    expect(fire({ pop: 3, threshold: 2 })).toBe(false));
  it("holds the percentile once the server has grown past the floor", () =>
    expect(fire({ pop: 6, threshold: 8 })).toBe(false));
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
