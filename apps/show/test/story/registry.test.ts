import { describe, it, expect } from "vitest";
import { PlayerTexts, TEXT_CAPS } from "../../src/story/registry.js";

describe("PlayerTexts", () => {
  it("records each string once with every kind it was used as", () => {
    const t = new PlayerTexts();
    t.gamertag("SNA");
    expect(t.clan("SNA", "SNA")).toEqual({ name: "SNA", tag: "SNA" });
    expect(t.entries()).toEqual([{ text: "SNA", kinds: ["clanName", "clanTag", "gamertag"], tagOf: "SNA" }]);
  });

  it("remembers which tag a clan name belongs to", () => {
    const t = new PlayerTexts();
    t.clan("Zone 2", "Z2");
    expect(t.entries()).toEqual([
      { text: "Z2", kinds: ["clanTag"], tagOf: null },
      { text: "Zone 2", kinds: ["clanName"], tagOf: "Z2" },
    ]);
  });

  it("caps player text at spec §6.4 lengths and returns the capped form", () => {
    const t = new PlayerTexts();
    const pitch = t.pitch("x".repeat(500));
    expect(pitch).toHaveLength(TEXT_CAPS.pitch);
    expect(t.bountyReason("y".repeat(500))).toHaveLength(100);
    expect(t.entries().map((e) => e.text.length)).toEqual([200, 100]);
  });
});
