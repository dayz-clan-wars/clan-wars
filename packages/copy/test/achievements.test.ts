import { describe, it, expect } from "vitest";
import { achievementSummaryLine, armoryCount, ARMORY_LABEL } from "../src/index";

/** Wording shared by the bot and the site (spec 2026-10-20-achievements-150). */
describe("achievement copy", () => {
  it("the summary DM's sentence", () => {
    expect(achievementSummaryLine(3)).toBe("You already hold 3 of the new achievements.");
    expect(achievementSummaryLine(1)).toBe("You already hold 1 of the new achievements.");
    expect(achievementSummaryLine(Number.NaN)).toBe("You already hold some of the new achievements.");
  });
  it("the armory section's count", () => {
    expect(ARMORY_LABEL).toBe("Armory");
    expect(armoryCount(7, 59)).toBe("7 of 59");
  });
});
