import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { POSITION_FIX_MS } from "@factions/domain";
import { RETRY_STEPS_MS, loadView, nextPollDelay, requestGate, retryDelay } from "../lib/map-load";

describe("loadView", () => {
  it("is loading until the map exists", () => {
    expect(loadView({ mapReady: false, error: null, leafletFailed: false })).toBe("loading");
  });

  /**
   * ⚠️ Review focus 2. A failed FIRST request used to show "could not be
   * refreshed — what you see may be out of date" over a black screen with
   * nothing on it, and wait five minutes to try again.
   */
  it("is failed-first, not stale, when the map never appeared", () => {
    expect(loadView({ mapReady: false, error: "failed", leafletFailed: false })).toBe("failed-first");
    expect(loadView({ mapReady: false, error: null, leafletFailed: true })).toBe("failed-first");
  });

  it("is stale only once there is a map to be out of date", () => {
    expect(loadView({ mapReady: true, error: "failed", leafletFailed: false })).toBe("stale");
    expect(loadView({ mapReady: true, error: null, leafletFailed: false })).toBe("ready");
  });

  it("puts a session or link problem above everything", () => {
    expect(loadView({ mapReady: false, error: "unauthenticated", leafletFailed: true })).toBe("terminal");
    expect(loadView({ mapReady: true, error: "not-linked", leafletFailed: false })).toBe("terminal");
  });
});

describe("retryDelay", () => {
  it("backs off 15 s, then 60 s, then the ordinary poll", () => {
    expect(RETRY_STEPS_MS).toEqual([15_000, 60_000]);
    expect(retryDelay(1, POSITION_FIX_MS)).toBe(15_000);
    expect(retryDelay(2, POSITION_FIX_MS)).toBe(60_000);
    expect(retryDelay(3, POSITION_FIX_MS)).toBe(POSITION_FIX_MS);
    expect(retryDelay(40, POSITION_FIX_MS)).toBe(POSITION_FIX_MS);
  });

  it("is the ordinary poll after a success", () => {
    expect(retryDelay(0, POSITION_FIX_MS)).toBe(POSITION_FIX_MS);
  });
});

describe("requestGate", () => {
  /**
   * ⚠️ Review focus 3. A Refresh tapped while the poll's request was out
   * raced it, and whichever answered LAST won, so an older snapshot could
   * overwrite a newer one.
   */
  it("applies only the newest request's answer, whatever order they settle in", () => {
    const gate = requestGate();
    const poll = gate.begin();
    const tap = gate.begin();
    // The tap answers first; the poll's older answer lands after it.
    expect(gate.isLatest(tap)).toBe(true);
    expect(gate.isLatest(poll)).toBe(false);
  });

  it("keeps separate gates separate", () => {
    const a = requestGate();
    const b = requestGate();
    const n = a.begin();
    b.begin();
    b.begin();
    expect(a.isLatest(n)).toBe(true);
  });
});

describe("nextPollDelay", () => {
  it("asks for nothing while the tab is hidden", () => {
    expect(nextPollDelay({ failures: 0, hidden: true }, POSITION_FIX_MS)).toBeNull();
    expect(nextPollDelay({ failures: 2, hidden: true }, POSITION_FIX_MS)).toBeNull();
  });

  it("is the backoff while visible", () => {
    expect(nextPollDelay({ failures: 1, hidden: false }, POSITION_FIX_MS)).toBe(15_000);
    expect(nextPollDelay({ failures: 0, hidden: false }, POSITION_FIX_MS)).toBe(POSITION_FIX_MS);
  });
});

describe("map-view.tsx's loading", () => {
  const view = readFileSync(join(import.meta.dirname, "..", "app", "(site)", "map", "map-view.tsx"), "utf8");

  it("imports Leaflet in one place, started on mount beside the first fetch", () => {
    expect(view.match(/import\("leaflet"\)/gu)).toHaveLength(1);
    expect(view).toMatch(/void load\(\);\s*importLeaflet\(\)\.catch/u);
  });

  it("aborts a superseded request, and refreshes when the tab comes back", () => {
    expect(view).toContain("signal: ctl.signal");
    expect(view).toContain('addEventListener("visibilitychange"');
  });
});
