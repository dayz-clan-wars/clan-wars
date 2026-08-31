import { describe, it, expect } from "vitest";
import { CLAIMABLE_FLAGS, NEUTRAL_FLAG, isClaimableFlag, armbandFor } from "../src/flags.js";

describe("flag pool", () => {
  it("offers exactly 33 claimable flags", () => {
    expect(CLAIMABLE_FLAGS).toHaveLength(33);
  });

  it("never offers the neutral flag", () => {
    // Flag_White is the unclaimed state and the ceremony's enforcement hook.
    // A faction holding it would make every pole look unclaimed.
    expect(NEUTRAL_FLAG).toBe("Flag_White");
    expect(CLAIMABLE_FLAGS).not.toContain(NEUTRAL_FLAG);
    expect(isClaimableFlag(NEUTRAL_FLAG)).toBe(false);
  });

  it("has no duplicates", () => {
    expect(new Set(CLAIMABLE_FLAGS).size).toBe(CLAIMABLE_FLAGS.length);
  });

  it("derives the armband by substitution", () => {
    expect(armbandFor("Flag_Zenit")).toBe("Armband_Zenit");
  });

  it("refuses an armband for anything outside the pool", () => {
    // A 1:1 mapping only holds for the 33. Returning a plausible-looking
    // string for an unknown texture would invent an item that does not exist.
    expect(armbandFor("Flag_Nonsense")).toBeNull();
    expect(armbandFor(NEUTRAL_FLAG)).toBeNull();
  });
});
