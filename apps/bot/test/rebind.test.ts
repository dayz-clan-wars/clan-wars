import { describe, it, expect } from "vitest";
import {
  selectCandidates, RELEASE_GRACE_MS,
  type QualifyingRaise,
} from "@factions/roster/internal";
import { RELEASED_POLE_GRACE_MS } from "@factions/domain";

const now = new Date("2026-09-03T12:00:00Z");
const WINDOW_MS = 3_600_000;
const ago = (ms: number) => new Date(now.getTime() - ms);

const raise = (o: Partial<QualifyingRaise>): QualifyingRaise => ({
  poleKey: "10.00:20.00:30.00", x: 10, y: 20, z: 30,
  dayzId: "A".repeat(40), gamertag: "Someone", occurredAt: ago(1000), eventId: 1, ...o,
});

describe("selectCandidates", () => {
  const opts = { currentPoleKey: "1.00:1.00:1.00", now, windowMs: WINDOW_MS };

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
    expect(selectCandidates([raise({ occurredAt: ago(WINDOW_MS + 1) })], opts)).toEqual([]);
  });

  it("keeps a raise exactly at the window edge", () => {
    expect(selectCandidates([raise({ occurredAt: ago(WINDOW_MS) })], opts)).toHaveLength(1);
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

describe("the release grace", () => {
  it("is the rules' released-pole grace (the no-moving-back window)", () => {
    expect(RELEASE_GRACE_MS).toBe(RELEASED_POLE_GRACE_MS);
  });
});
