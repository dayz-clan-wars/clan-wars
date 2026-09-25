import { describe, it, expect } from "vitest";
import {
  chooseKothTown, kothGapOk, shouldFireKoth, turnoutFloor, voteOutcome, voteTargetSlot, voteClosesAt,
  KOTH_LOCATIONS, KOTH_NO_REPEAT, KOTH_MIN_GAP_MS, KOTH_VOTE_TURNOUT_MIN, KOTH_REMINDER_LEAD_MS,
  AIRDROP_DECIDE_LEAD_MS, type KothFireInput,
} from "../src/index.js";

// F4: two statements of one fact. `koth-decide-tick.ts`'s `announce()` stamps
// `reminded_at` alongside `announced_at` on the assumption that the decision instant
// (`decisionInstantFor`, `AIRDROP_DECIDE_LEAD_MS`) IS the reminder instant
// (`KOTH_REMINDER_LEAD_MS`) — and "KotH wins the slot" (spec §2.12) depends on
// `kothDecideTick` and `airdropTick` deciding at the same instant, which only holds if
// these two leads are equal. A drifted pair breaks both silently: no test fails, the
// decide tick just stops matching the reminder, and airdrop/koth stop racing for the
// same slot at the same tick.
it("keeps the KotH reminder lead and the airdrop decide lead equal", () => {
  expect(KOTH_REMINDER_LEAD_MS).toBe(AIRDROP_DECIDE_LEAD_MS);
});

const at = (iso: string) => new Date(iso);
const SLOT = at("2026-10-03T20:00:00Z");

describe("kothGapOk", () => {
  it("allows no previous event", () => expect(kothGapOk(SLOT, null)).toBe(true));
  it("allows exactly 24 h", () => expect(kothGapOk(SLOT, new Date(SLOT.getTime() - KOTH_MIN_GAP_MS))).toBe(true));
  it("refuses 22 h", () => expect(kothGapOk(SLOT, at("2026-10-02T22:00:00Z"))).toBe(false));
});

describe("chooseKothTown", () => {
  it("never draws one of the last KOTH_NO_REPEAT towns", () => {
    const recent = KOTH_LOCATIONS.slice(0, KOTH_NO_REPEAT).map((l) => l.slug);
    for (let i = 0; i < 50; i++) {
      expect(recent).not.toContain(chooseKothTown(recent, () => i / 50).slug);
    }
  });
  // ⚠️ An empty pool indexes undefined; the fallback is what keeps the tick alive.
  it("falls back to the whole list when every town is recent", () => {
    const all = KOTH_LOCATIONS.map((l) => l.slug);
    expect(KOTH_LOCATIONS).toContainEqual(chooseKothTown(all, () => 0));
  });
});

describe("shouldFireKoth", () => {
  const base: KothFireInput = {
    slot: SLOT, slotTaken: false, voteBlocks: false, openEvent: false, weekCount: 0, weeklyCap: 2,
    lastSlotAt: null, pop: 12, threshold: 11, minPop: 10,
  };
  it("fires at a new high", () => expect(shouldFireKoth(base)).toBe(true));
  it("fires on a tie with the high-water mark", () => expect(shouldFireKoth({ ...base, pop: 11 })).toBe(true));
  it("refuses below the high-water mark", () => expect(shouldFireKoth({ ...base, pop: 10 })).toBe(false));
  it("refuses below the floor even with no history", () => expect(shouldFireKoth({ ...base, pop: 9, threshold: 0 })).toBe(false));
  it("refuses a taken slot", () => expect(shouldFireKoth({ ...base, slotTaken: true })).toBe(false));
  it("refuses a slot a vote blocks", () => expect(shouldFireKoth({ ...base, voteBlocks: true })).toBe(false));
  it("refuses while an event is open", () => expect(shouldFireKoth({ ...base, openEvent: true })).toBe(false));
  it("refuses at the weekly cap", () => expect(shouldFireKoth({ ...base, weekCount: 2 })).toBe(false));
  it("refuses inside the gap", () => expect(shouldFireKoth({ ...base, lastSlotAt: at("2026-10-03T00:00:00Z") })).toBe(false));
});

describe("turnoutFloor", () => {
  it("never goes below the minimum", () => {
    expect(turnoutFloor(5)).toBe(KOTH_VOTE_TURNOUT_MIN);
    expect(turnoutFloor(10)).toBe(5);
  });
  it("is half the electorate, rounded up", () => expect(turnoutFloor(11)).toBe(6));
});

describe("voteOutcome", () => {
  it("passes at exactly two-thirds", () => expect(voteOutcome({ cast: 6, yes: 4, floor: 5 })).toEqual({ outcome: "passed", reason: "passed" }));
  it("fails one Yes short", () => expect(voteOutcome({ cast: 7, yes: 4, floor: 5 })).toEqual({ outcome: "failed", reason: "majority" }));
  it("fails one voter short of the floor, even unanimous", () => expect(voteOutcome({ cast: 4, yes: 4, floor: 5 })).toEqual({ outcome: "failed", reason: "turnout" }));
});

describe("voteTargetSlot", () => {
  // Closes at slot − 30 min; must be open at least 10 min.
  it("targets the next slot when its close is 10+ min away", () => {
    expect(voteTargetSlot(at("2026-10-03T19:20:00Z"))).toEqual(SLOT);
  });
  it("rolls to the slot after when under 10 min remain", () => {
    expect(voteTargetSlot(at("2026-10-03T19:21:00Z"))).toEqual(at("2026-10-03T22:00:00Z"));
  });
  it("closes 30 min before the slot", () => expect(voteClosesAt(SLOT)).toEqual(at("2026-10-03T19:30:00Z")));
});
