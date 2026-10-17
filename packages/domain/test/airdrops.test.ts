import { describe, it, expect } from "vitest";
import {
  AIRDROP_MIN_GAP_MS, AIRDROP_NO_REPEAT, chooseAirdrop, shouldFire,
} from "../src/airdrops";
import { BUNKER_KINDS, BUNKER_ROOMS } from "../src/bunker";

const at = (iso: string) => new Date(iso);
const fire = (over: Partial<Parameters<typeof shouldFire>[0]> = {}) => shouldFire({
  pop: 6, threshold: 5, minPop: 5, weekCount: 0, weeklyCap: 2,
  lastFireAt: null, openEvent: false, now: at("2026-09-21T19:30:00Z"), ...over,
});


describe("chooseAirdrop", () => {
  const slugs = BUNKER_ROOMS.map((r) => r.slug);
  it("never draws one of the last AIRDROP_NO_REPEAT rooms, and draws a kind", () => {
    const recent = slugs.slice(0, AIRDROP_NO_REPEAT);
    for (let i = 0; i < 200; i++) {
      const spec = chooseAirdrop([...recent], () => i / 200);
      expect(recent).not.toContain(spec.location);
      expect(slugs).toContain(spec.location);
      expect(BUNKER_KINDS).toContain(spec.kind);
    }
  });
  // ⚠️ An empty pool indexes undefined; the fallback is what keeps the tick alive.
  it("falls back to all 11 when every room is recent", () => {
    expect(slugs).toContain(chooseAirdrop([...slugs], () => 0).location);
  });
  it("draws both kinds", () => {
    expect(new Set([0, 0.99].map((r) => chooseAirdrop([], () => r).kind))).toEqual(new Set(["boom", "guns"]));
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
