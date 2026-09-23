import { describe, it, expect } from "vitest";
import {
  sentenceMsFor, boostStackFor, type IncidentDamage, type BoostPlacement,
  BAN_BASE_MS, BAN_BREACH_MS, BAN_GATE_MS, BAN_PER_DISMANTLE_MS,
  BAN_FIRST_OFFENCE_CAP_MS, BOOST_STACK_RADIUS_M,
} from "../src/index.js";

const HOUR = 3_600_000;
const damage = (d: Partial<IncidentDamage> = {}): IncidentDamage => ({
  partsDismantled: 0, partsBuilt: 0, stackItems: 0, hasBreach: false, hasGate: false, ...d,
});

describe("sentenceMsFor", () => {
  it("a bare incident is the base term", () => {
    expect(sentenceMsFor(damage(), 0)).toBe(BAN_BASE_MS);
  });

  it("any breach adds the flat breach term, regardless of how many items caused it", () => {
    const one = sentenceMsFor(damage({ hasBreach: true, stackItems: 2 }), 0);
    const many = sentenceMsFor(damage({ hasBreach: true, stackItems: 5 }), 0);
    expect(one).toBe(BAN_BASE_MS + BAN_BREACH_MS);
    expect(many).toBe(one);
  });

  it("a gate conversion adds its own term on top of the breach", () => {
    expect(sentenceMsFor(damage({ hasBreach: true, hasGate: true, partsBuilt: 1 }), 0))
      .toBe(BAN_BASE_MS + BAN_BREACH_MS + BAN_GATE_MS);
  });

  it("loss scales per dismantled part", () => {
    expect(sentenceMsFor(damage({ partsDismantled: 3 }), 0))
      .toBe(BAN_BASE_MS + 3 * BAN_PER_DISMANTLE_MS);
  });

  it("a first offence is capped", () => {
    expect(sentenceMsFor(damage({ partsDismantled: 100, hasBreach: true, hasGate: true }), 0))
      .toBe(BAN_FIRST_OFFENCE_CAP_MS);
  });

  it("a second offence doubles, and the cap applies before the multiplier", () => {
    expect(sentenceMsFor(damage({ partsDismantled: 100 }), 1)).toBe(BAN_FIRST_OFFENCE_CAP_MS * 2);
    expect(sentenceMsFor(damage(), 1)).toBe(BAN_BASE_MS * 2);
  });

  it("a third offence in the season is permanent", () => {
    expect(sentenceMsFor(damage(), 2)).toBeNull();
    expect(sentenceMsFor(damage({ partsDismantled: 1 }), 7)).toBeNull();
  });
});

describe("boostStackFor", () => {
  const t0 = new Date("2026-09-15T12:00:00Z");
  const at = (ms: number) => new Date(t0.getTime() + ms);
  let nextEventId = 1;
  const p = (x: number, y: number, z: number, ms: number, dayzId = "A".repeat(40)): BoostPlacement =>
    ({ dayzId, eventId: nextEventId++, x, y, z, occurredAt: at(ms) });

  it("two co-located placements with the player rising is a stack", () => {
    const first = p(100, 10.0, 100, 0);
    const second = p(100.4, 10.9, 100.3, 60_000);
    const stack = boostStackFor([first], second);
    expect(stack).toHaveLength(2);
    expect(stack![0]).toBe(first);
  });

  it("a side-by-side farm is not a stack — the plots are further apart than their own footprint", () => {
    const first = p(100, 10.0, 100, 0);
    const second = p(100 + BOOST_STACK_RADIUS_M + 1, 10.0, 100, 60_000);
    expect(boostStackFor([first], second)).toBeNull();
  });

  it("two cook-fires on a hillside are not a stack — the rise is there but they are not co-located", () => {
    const first = p(100, 10.0, 100, 0);
    const second = p(106, 12.5, 100, 60_000);
    expect(boostStackFor([first], second)).toBeNull();
  });

  it("a fireplace dropped and replaced in one spot is not a stack — co-located but no rise", () => {
    const first = p(100, 10.0, 100, 0);
    const second = p(100.2, 10.05, 100.1, 60_000);
    expect(boostStackFor([first], second)).toBeNull();
  });

  it("a placement outside the time window does not join the cluster", () => {
    const old = p(100, 10.0, 100, -(4 * HOUR));
    const fresh = p(100.2, 11.0, 100.1, 0);
    expect(boostStackFor([old], fresh)).toBeNull();
  });

  it("mixed contributors both appear in the cluster — a stack may be a one- or two-man job", () => {
    const a = p(100, 10.0, 100, 0, "A".repeat(40));
    const b = p(100.3, 11.0, 100.2, 30_000, "B".repeat(40));
    const stack = boostStackFor([a], b);
    expect(stack!.map((s) => s.dayzId)).toEqual(["A".repeat(40), "B".repeat(40)]);
  });

  it("a three-high stack returns all three in chronological order", () => {
    const a = p(100, 10.0, 100, 0);
    const b = p(100.2, 10.8, 100.1, 20_000);
    const c = p(100.1, 11.7, 100.2, 40_000);
    expect(boostStackFor([a, b], c)).toEqual([a, b, c]);
  });
});

import { BAN_REASONS, BAN_REASON_TEXT } from "../src/enforcement";
describe("BAN_REASON_TEXT", () => {
  it("every ban reason has player-facing wording", () => {
    expect(BAN_REASONS).toContain("hub_combat");
    for (const r of BAN_REASONS) expect(BAN_REASON_TEXT[r]).toMatch(/\S/u);
    expect(BAN_REASON_TEXT.zone).toBe("base-zone enforcement");
    expect(BAN_REASON_TEXT.hub_combat).toBe("combat at the Fast Travel Hub");
  });
});
