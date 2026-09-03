import { describe, it, expect } from "vitest";
import {
  selectCandidates, cooldownRemainingMs,
  REBIND_COOLDOWN_MS, RELEASE_GRACE_MS, REBIND_WINDOW_MS,
  type QualifyingRaise,
} from "../src/rebind.js";

const now = new Date("2026-09-03T12:00:00Z");
const ago = (ms: number) => new Date(now.getTime() - ms);

const raise = (o: Partial<QualifyingRaise>): QualifyingRaise => ({
  poleKey: "10.00:20.00:30.00", x: 10, y: 20, z: 30,
  dayzId: "A".repeat(40), gamertag: "Someone", occurredAt: ago(1000), ...o,
});

describe("selectCandidates", () => {
  const opts = { currentPoleKey: "1.00:1.00:1.00", now };

  it("accepts a recent raise at a different pole", () => {
    expect(selectCandidates([raise({})], opts)).toHaveLength(1);
  });

  it("⚠️ never offers the faction's CURRENT pole", () => {
    // Rebinding onto your own pole is a no-op write that would still burn the
    // 7-day cooldown, so a leader could lock themselves out by confirming the
    // ordinary weekly flag raise at home.
    expect(selectCandidates([raise({ poleKey: "1.00:1.00:1.00" })], opts)).toEqual([]);
  });

  it("drops raises older than the window", () => {
    expect(selectCandidates([raise({ occurredAt: ago(REBIND_WINDOW_MS + 1) })], opts)).toEqual([]);
  });

  it("keeps a raise exactly at the window edge", () => {
    expect(selectCandidates([raise({ occurredAt: ago(REBIND_WINDOW_MS) })], opts)).toHaveLength(1);
  });

  it("collapses repeated raises at one pole to the newest", () => {
    const older = raise({ occurredAt: ago(3000), gamertag: "Older" });
    const newer = raise({ occurredAt: ago(1000), gamertag: "Newer" });
    const out = selectCandidates([older, newer], opts);
    expect(out).toHaveLength(1);
    expect(out[0]!.gamertag).toBe("Newer");
  });

  it("returns several poles newest-first", () => {
    const a = raise({ poleKey: "2.00:2.00:2.00", occurredAt: ago(3000) });
    const b = raise({ poleKey: "3.00:3.00:3.00", occurredAt: ago(1000) });
    expect(selectCandidates([a, b], opts).map((c) => c.poleKey))
      .toEqual(["3.00:3.00:3.00", "2.00:2.00:2.00"]);
  });
});

describe("cooldownRemainingMs", () => {
  it("is zero for a faction that has never rebound", () => {
    expect(cooldownRemainingMs(null, now)).toBe(0);
  });

  it("is zero once the cooldown has fully elapsed", () => {
    expect(cooldownRemainingMs(ago(REBIND_COOLDOWN_MS), now)).toBe(0);
  });

  it("reports what is left inside the cooldown", () => {
    expect(cooldownRemainingMs(ago(REBIND_COOLDOWN_MS - 5000), now)).toBe(5000);
  });
});

describe("the release grace and the rebind cooldown", () => {
  it("⚠️ RELEASE_GRACE_MS must stay STRICTLY shorter than REBIND_COOLDOWN_MS", () => {
    // Spec §2.4. At equal values a faction can alternate between two poles and
    // keep BOTH permanently private: rebind away, the old pole's grace covers
    // it until the cooldown expires, rebind back. One extra base for the price
    // of a weekly ritual.
    //
    // ⚠️ This reopens SILENTLY. Nothing errors, no behaviour visibly changes,
    // and no other test fails — a faction just quietly holds two private bases
    // forever. This assertion is the only thing standing between those two
    // numbers, and it fails whether someone RAISES the grace or LOWERS the
    // cooldown.
    expect(RELEASE_GRACE_MS).toBeLessThan(REBIND_COOLDOWN_MS);
  });

  it("holds the documented values, so a silent edit to either is visible", () => {
    expect(REBIND_COOLDOWN_MS).toBe(604_800_000); // 7 days
    expect(RELEASE_GRACE_MS).toBe(259_200_000); //  3 days
  });
});
