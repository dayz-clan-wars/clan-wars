// apps/bot/test/referral-award-text.test.ts
import { describe, it, expect } from "vitest";
import { referralWinnersText } from "../src/referral-award-text.js";

describe("referralWinnersText", () => {
  it("names one winner", () => {
    expect(referralWinnersText(["Otto"], 3)).toBe("Top referrer this week: **Otto**, who brought in 3 new players. They get a weapon kit for a week.");
  });
  it("says player for one", () => {
    expect(referralWinnersText(["Otto"], 1)).toContain("brought in 1 new player.");
  });
  it("names a tie", () => {
    expect(referralWinnersText(["Otto", "Cleo"], 2)).toBe("Top referrers this week: **Otto** and **Cleo**, with 2 new players each. They each get a weapon kit for a week.");
    expect(referralWinnersText(["A", "B", "C"], 1)).toContain("**A**, **B** and **C**, with 1 new player each.");
  });
  it("escapes markdown in names and uses no em dash", () => {
    expect(referralWinnersText(["_x_"], 1)).toContain("**\\_x\\_**");
    expect(referralWinnersText(["A", "B"], 2)).not.toMatch(/—/);
  });
});
