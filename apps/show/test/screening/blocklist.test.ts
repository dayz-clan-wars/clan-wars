import { describe, it, expect } from "vitest";
import { blocklistHit, normalizeForms } from "../../src/screening/blocklist.js";

describe("blocklist", () => {
  it("normalizes lookalikes, leet, separators and repeats", () => {
    const f = normalizeForms("N\u0430\u0430Z_1s"); // Cyrillic \u0430 twice
    expect(f.alnum).toBe("naaz1s");
    expect(f.letters).toBe("naazis");
    expect(f.collapsed).toBe("nazis");
  });

  it.each([
    "Nazis", "N4Z1", "n a z i", "Naaaazi", "n\u0430zi", "xX_H1tl3r_Xx", "SiegHeil", "Sieg Heil", "1488Crew", "14/88", "14 88",
    "KKK", "k k k", "WhitePower", "White Power", "\u5350", "Third Reich", "Pavel: welcome, n4z1 friends",
    "na z i", "h i tler", "nig g er",
  ])("⚠️ blocks %s", (s) => {
    expect(blocklistHit(s)).not.toBeNull();
  });

  it.each([
    "The Cocks", "Zone 2", "GoldSkull588", "NightHowlers", "Dead Reckoning", "SNA", "TOXIC REAPER680",
    "chaandlr", "Keeter69", "RedStone8700", "Bubba211558", "For funsies", "Pledge vengeance for all the slain chickens",
    "Flag_Zagorky", "Spicy Sniper", "Raccoon",
    // ⚠️ Prose the output screen will see: joined across words, each of these hits a term.
    "Boris: the illness spreads.", "Pavel: ok I keep saying it.", "Boris: not such inkling.", "Pavel: I am retiring, Boris.",
    "Boris: gas the generator before the raid.", "Pavel: there is a chink in the armor.",
    "Boris: retard the throttle, Pavel.", "Pavel: the tranny on my truck is shot.",
  ])("allows %s", (s) => {
    expect(blocklistHit(s)).toBeNull();
  });

  it("does not block 88 alone: Xbox appends digits, the moderator judges it in context", () => {
    expect(blocklistHit("Bob1988")).toBeNull();
    expect(blocklistHit("Sniper88")).toBeNull();
  });
});
