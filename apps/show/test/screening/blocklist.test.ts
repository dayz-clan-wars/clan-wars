import { describe, it, expect } from "vitest";
import { blocklistHit, normalizeForms } from "../../src/screening/blocklist.js";

describe("blocklist", () => {
  it("normalizes lookalikes, leet, separators and repeats", () => {
    const f = normalizeForms("NааZ_1s"); // Cyrillic а twice
    expect(f.alnum).toBe("naaz1s");
    expect(f.letters).toBe("naazis");
    expect(f.collapsed).toBe("nazis");
  });

  it.each([
    "Nazis", "N4Z1", "n a z i", "Naaaazi", "nаzi", "xX_H1tl3r_Xx", "SiegHeil", "Sieg Heil", "1488Crew", "14/88", "14 88",
    "KKK", "k k k", "WhitePower", "White Power", "卐", "Third Reich", "Pavel: welcome, n4z1 friends",
  ])("⚠️ blocks %s", (s) => {
    expect(blocklistHit(s)).not.toBeNull();
  });

  it.each([
    "The Cocks", "Zone 2", "GoldSkull588", "NightHowlers", "Dead Reckoning", "SNA", "TOXIC REAPER680",
    "chaandlr", "Keeter69", "RedStone8700", "Bubba211558", "For funsies", "Pledge vengeance for all the slain chickens",
    "Flag_Zagorky", "Spicy Sniper", "Raccoon",
    // ⚠️ Prose the output screen will see: joined across words, each of these hits a term.
    "Boris: the illness spreads.", "Pavel: ok I keep saying it.", "Boris: not such inkling.", "Pavel: I am retiring, Boris.",
  ])("allows %s", (s) => {
    expect(blocklistHit(s)).toBeNull();
  });

  it("does not block 88 alone: Xbox appends digits, the moderator judges it in context", () => {
    expect(blocklistHit("Bob1988")).toBeNull();
    expect(blocklistHit("Sniper88")).toBeNull();
  });
});
