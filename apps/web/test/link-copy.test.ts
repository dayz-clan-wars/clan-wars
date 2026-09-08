import { describe, it, expect } from "vitest";
import { ISSUE_OUTCOME_KINDS } from "@factions/roster";
import { ISSUE_COPY, ENDED_COPY, UNLINK_COPY, formatRemaining } from "../lib/link-copy";

describe("link copy", () => {
  it("has a line for every outcome the package can return", () => {
    for (const kind of ISSUE_OUTCOME_KINDS) {
      expect(typeof ISSUE_COPY[kind]).toBe("function");
      expect(ISSUE_COPY[kind]({ kind: "unknown-character" }).length).toBeGreaterThan(10);
    }
  });
  it("covers every way a challenge can end without the player", () => {
    expect(Object.keys(ENDED_COPY).sort()).toEqual(["already-linked", "budget-exhausted", "expired"]);
  });
  it("covers every unlink code the route can redirect with", () => {
    expect(Object.keys(UNLINK_COPY).sort()).toEqual(["in-clan", "not-linked", "ok"]);
  });
  it("formats a remainder as m:ss and clamps at zero", () => {
    expect(formatRemaining(9 * 60_000 + 41_000)).toBe("9:41");
    expect(formatRemaining(24 * 3_600_000 - 1)).toBe("23 h 59 min");
    expect(formatRemaining(3_600_000)).toBe("1 h 0 min");
    expect(formatRemaining(3_600_000 - 1)).toBe("59:59");
    expect(formatRemaining(5_000)).toBe("0:05");
    expect(formatRemaining(-1)).toBe("0:00");
  });
});
