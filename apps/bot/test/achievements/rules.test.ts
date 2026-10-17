import { describe, it, expect } from "vitest";
import { EARNABLE_ACHIEVEMENTS } from "@factions/domain";
import { RULES } from "../../src/achievements/rules.js";

describe("the rule registry", () => {
  it("has exactly one rule per earnable key, and none for a retired or undefined one", () => {
    expect(Object.keys(RULES).sort()).toEqual(EARNABLE_ACHIEVEMENTS.map((a) => a.key).sort());
  });
});
