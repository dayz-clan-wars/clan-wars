import { describe, it, expect } from "vitest";
import { deriveClockOffsetMs } from "../src/derive-clock-offset.js";

const HOUR = 3_600_000;

describe("deriveClockOffsetMs", () => {
  it("takes the minimum candidate", () => {
    // Each file's mtime is at or AFTER its creation, so every candidate
    // over-estimates the offset by however long the file was written to.
    // The smallest is the tightest bound.
    expect(deriveClockOffsetMs([
      { localTimestampMs: 0, modifiedAtMs: 7 * HOUR },
      { localTimestampMs: 0, modifiedAtMs: 9 * HOUR },
    ])).toBe(7 * HOUR);
  });

  it("returns null for no candidates rather than zero", () => {
    // ⚠️ Zero is the silent failure this whole column guards against: every
    // row lands, every count-based check stays green, and only the instants
    // are hours wrong. The caller must fall back to the stored value.
    expect(deriveClockOffsetMs([])).toBeNull();
  });

  it("handles a single candidate", () => {
    expect(deriveClockOffsetMs([{ localTimestampMs: 1000, modifiedAtMs: 1000 + 4 * HOUR }])).toBe(4 * HOUR);
  });

  it("produces the measured Livonia offset from realistic inputs", () => {
    // The production table measured Livonia at UTC+7 against 69,326 rows.
    const local = Date.UTC(2026, 6, 22, 1, 0, 0);
    expect(deriveClockOffsetMs([{ localTimestampMs: local, modifiedAtMs: local + 7 * HOUR }])).toBe(7 * HOUR);
  });

  it("documents the hazard: a zero mtime poisons the minimum", () => {
    // This test documents the hazard rather than endorsing it. A zero mtime
    // (from a missing upload mtime) wins the minimum and produces a hugely
    // negative offset, shifting every ingested timestamp by decades. This is
    // the exact class of silent failure this module prevents — but on the
    // caller's side. The function is behaving correctly; the test exists so a
    // future reader sees the consequence rather than reasoning about it.
    const realistic = { localTimestampMs: 1000, modifiedAtMs: 1000 + 7 * HOUR };
    const missing = { localTimestampMs: 1000, modifiedAtMs: 0 };
    const result = deriveClockOffsetMs([realistic, missing]);
    // modifiedAtMs: 0, localTimestampMs: 1000 → offset = -1000, which the
    // 15-minute grid snap then floors to -900_000. Still a wildly wrong
    // offset; the snapping does not rescue a poisoned candidate.
    expect(result).toBe(-900_000);
  });

  it("snaps the minimum DOWN to the 15-minute grid", () => {
    // Every candidate is `trueOffset + writeLag`, so the minimum is
    // `trueOffset + smallestLag`. Real timezone offsets are whole 15-minute
    // units, so flooring to the grid recovers the true offset exactly
    // whenever the smallest write-lag is under 15 minutes.
    const min = 7 * HOUR + 43_000;
    expect(deriveClockOffsetMs([
      { localTimestampMs: 0, modifiedAtMs: min },
      { localTimestampMs: 0, modifiedAtMs: 9 * HOUR },
    ])).toBe(7 * HOUR);
  });

  it("snaps a negative offset correctly, flooring toward negative infinity", () => {
    // Derivation, worked out rather than guessed:
    //   min           = -4h + 43s = -14_400_000 + 43_000 = -14_357_000
    //   min / 900_000 = -15.952...
    //   Math.floor    = -16          (toward negative infinity)
    //   -16 * 900_000 = -14_400_000  = exactly -4h
    // Flooring lands ON the grid point the true offset occupies rather than
    // overshooting a step past it, because the lag pushed the minimum ABOVE
    // -4h, not below it.
    const min = -4 * HOUR + 43_000;
    expect(deriveClockOffsetMs([{ localTimestampMs: 0, modifiedAtMs: min }])).toBe(-4 * HOUR);
  });
});
