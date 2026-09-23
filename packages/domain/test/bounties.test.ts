import { describe, it, expect } from "vitest";
import {
  BOUNTY_EXPIRY_SETTLE_MS, BOUNTY_STATUSES, budgetRunOutAt, bountyOutcome, onlineMs, type SessionSpan,
} from "../src/index";

const H = 3_600_000;
const t0 = new Date("2026-09-23T00:00:00Z");
const at = (h: number) => new Date(t0.getTime() + h * H);
const span = (from: number, to: number | null): SessionSpan => ({ from: at(from), to: to === null ? null : at(to) });

describe("onlineMs", () => {
  it("clips a session that started before the bounty to placed_at", () => {
    expect(onlineMs([span(-5, 2)], at(0), at(10))).toBe(2 * H);
  });
  it("runs an open session up to `until`", () => {
    expect(onlineMs([span(1, null)], at(0), at(4))).toBe(3 * H);
  });
  it("never double-counts overlapping spans", () => {
    expect(onlineMs([span(0, 3), span(2, 4)], at(0), at(10))).toBe(4 * H);
  });
  it("is zero for a player who never came online", () => {
    expect(onlineMs([], at(0), at(10))).toBe(0);
  });
});

describe("budgetRunOutAt", () => {
  it("finds the instant inside the session that exhausts the budget", () => {
    expect(budgetRunOutAt([span(0, 2), span(5, 9)], at(0), 3 * H, at(20))).toEqual(at(6));
  });
  it("is null while budget remains", () => {
    expect(budgetRunOutAt([span(0, 2)], at(0), 3 * H, at(20))).toBeNull();
  });
});

describe("bountyOutcome", () => {
  const b = { placedAt: at(0), onlineBudgetMs: 3 * H, deadlineAt: at(24 * 30) };
  const settle = BOUNTY_EXPIRY_SETTLE_MS;

  it("claims with a kill before the budget ran out", () => {
    expect(bountyOutcome(b, [span(0, 10)], at(2), at(10))).toEqual({ kind: "claimed" });
  });
  it("⚠️ still claims when the kill is ingested after the budget ran out (log lag)", () => {
    const now = new Date(at(3).getTime() + settle + 1);
    expect(bountyOutcome(b, [span(0, 10)], at(2.9), now)).toEqual({ kind: "claimed" });
  });
  it("does not claim with a kill after the budget ran out", () => {
    const now = new Date(at(4).getTime() + settle);
    expect(bountyOutcome(b, [span(0, 10)], at(3.5), now)).toEqual({ kind: "expired", endAt: at(3) });
  });
  it("⚠️ stays open for the settle window after the budget runs out", () => {
    expect(bountyOutcome(b, [span(0, 10)], null, new Date(at(3).getTime() + settle - 1))).toEqual({ kind: "open" });
  });
  it("expires at the deadline for a target who never plays", () => {
    const now = new Date(b.deadlineAt.getTime() + settle);
    expect(bountyOutcome(b, [], null, now)).toEqual({ kind: "expired", endAt: b.deadlineAt });
  });
  it("is open with time left and no kill", () => {
    expect(bountyOutcome(b, [span(0, 1)], null, at(5))).toEqual({ kind: "open" });
  });
});

it("names the four statuses the CHECK constraint holds", () => {
  expect([...BOUNTY_STATUSES]).toEqual(["open", "claimed", "expired", "revoked"]);
});
