import { describe, it, expect } from "vitest";
import {
  decide, DEFAULT_DORMANT_AFTER_MS, DEFAULT_DISBAND_AFTER_DORMANT_MS,
  type FactionClock,
} from "../src/dormancy.js";

const W = {
  dormantAfterMs: DEFAULT_DORMANT_AFTER_MS,
  disbandAfterDormantMs: DEFAULT_DISBAND_AFTER_DORMANT_MS,
};
const now = new Date("2026-09-02T12:00:00Z");
const ago = (ms: number) => new Date(now.getTime() - ms);
const clock = (o: Partial<FactionClock>): FactionClock =>
  ({ status: "active", lastRaiseAt: now, dormantSince: null, ...o });

describe("decide", () => {
  it("leaves an active faction alone while its flag is fresh", () => {
    expect(decide(clock({ lastRaiseAt: ago(DEFAULT_DORMANT_AFTER_MS - 1) }), now, W)).toBeNull();
  });

  it("goes dormant exactly at the window", () => {
    // The server's FlagRefreshMaxDuration is 7 days; at 7 days the base is
    // already decaying, so the boundary belongs to dormancy.
    expect(decide(clock({ lastRaiseAt: ago(DEFAULT_DORMANT_AFTER_MS) }), now, W)).toBe("dormant");
  });

  it("goes dormant past the window", () => {
    expect(decide(clock({ lastRaiseAt: ago(DEFAULT_DORMANT_AFTER_MS + 1) }), now, W)).toBe("dormant");
  });

  it("revives a dormant faction whose flag flew again", () => {
    expect(decide(clock({ status: "dormant", lastRaiseAt: ago(1000), dormantSince: ago(DEFAULT_DORMANT_AFTER_MS) }), now, W))
      .toBe("revive");
  });

  it("⚠️ revives rather than disbands when both would apply", () => {
    // A faction that raises its flag on day 20 of dormancy must be rescued by
    // the same tick that could have disbanded it. The loss is irreversible, so
    // the outcome must not depend on tick timing.
    expect(decide(clock({
      status: "dormant",
      lastRaiseAt: ago(1000),
      dormantSince: ago(DEFAULT_DISBAND_AFTER_DORMANT_MS + 86_400_000),
    }), now, W)).toBe("revive");
  });

  it("holds a dormant faction that is not yet due to disband", () => {
    expect(decide(clock({
      status: "dormant", lastRaiseAt: ago(DEFAULT_DORMANT_AFTER_MS * 2),
      dormantSince: ago(DEFAULT_DISBAND_AFTER_DORMANT_MS - 1),
    }), now, W)).toBeNull();
  });

  it("disbands exactly at the dormant window", () => {
    expect(decide(clock({
      status: "dormant", lastRaiseAt: ago(DEFAULT_DORMANT_AFTER_MS * 3),
      dormantSince: ago(DEFAULT_DISBAND_AFTER_DORMANT_MS),
    }), now, W)).toBe("disband");
  });

  it("⚠️ never disbands a dormant faction with no dormant_since — it stamps one", () => {
    // Reachable only if something outside this tick set the status. Losing a
    // flag to a missing timestamp is not acceptable; waiting another 14 days is.
    expect(decide(clock({
      status: "dormant", lastRaiseAt: ago(DEFAULT_DORMANT_AFTER_MS * 10), dormantSince: null,
    }), now, W)).toBe("stamp");
  });

  it("ignores reserved and disbanded factions entirely", () => {
    for (const status of ["reserved", "disbanded", "lapsed"]) {
      expect(decide(clock({ status, lastRaiseAt: ago(DEFAULT_DORMANT_AFTER_MS * 10) }), now, W)).toBeNull();
    }
  });

  it("treats a faction with no raise at all as stale", () => {
    // The store coalesces to activated_at/created_at, so null should not occur
    // — but a null that reached here must not read as 'fresh'.
    expect(decide(clock({ lastRaiseAt: null }), now, W)).toBe("dormant");
  });
});
