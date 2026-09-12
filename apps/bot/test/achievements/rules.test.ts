import { describe, it, expect } from "vitest";
import { ACHIEVEMENT_KEYS } from "@factions/domain";
import { RULES } from "../../src/achievements/rules.js";

describe("the rule registry", () => {
  it("has exactly one rule per achievement key, and no rule for a key that is not defined", () => {
    expect(Object.keys(RULES).sort()).toEqual([...ACHIEVEMENT_KEYS].sort());
  });
});
