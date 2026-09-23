import { describe, it, expect } from "vitest";
import { bountyPostText } from "../src/bounty-text.js";

const SITE = "https://dayzclanwars.com";
describe("bountyPostText", () => {
  it("announces a wanted player with the reason, the hours and the map link", () => {
    const t = bountyPostText({ kind: "placed", target: "Bob", reason: "Combat logging", hours: 72 }, SITE);
    expect(t).toContain("**Bob**"); expect(t).toContain("Combat logging"); expect(t).toContain("72 h"); expect(t).toContain(`${SITE}/map`);
    expect(t).toMatch(/friendly fire/iu);
  });
  it("credits the killer, with the weapon when known", () => {
    expect(bountyPostText({ kind: "claimed", target: "Bob", killer: "Ann", weapon: "M4-A1" }, SITE)).toBe("💀 **Ann** collected the bounty on **Bob** with M4-A1.");
    expect(bountyPostText({ kind: "claimed", target: "Bob", killer: "Ann", weapon: null }, SITE)).toBe("💀 **Ann** collected the bounty on **Bob**.");
  });
  it("escapes markdown in player-controlled names and reasons", () => {
    expect(bountyPostText({ kind: "expired", target: "**x**" }, SITE)).toContain("\\*\\*x\\*\\*");
  });
  it("escapes markdown link syntax in target names", () => {
    const t = bountyPostText({ kind: "expired", target: "[x](https://evil.example)" }, SITE);
    expect(t).not.toContain("[x](https://evil.example)");
    expect(t).toContain("\\[");
  });
  it("escapes spoiler syntax in target names", () => {
    const t = bountyPostText({ kind: "expired", target: "||s||" }, SITE);
    expect(t).not.toContain("||s||");
  });
  it("⚠️ never carries a coordinate", () => {
    const all = [
      bountyPostText({ kind: "placed", target: "B", reason: "r", hours: 1 }, SITE),
      bountyPostText({ kind: "claimed", target: "B", killer: "A", weapon: "AKM" }, SITE),
      bountyPostText({ kind: "expired", target: "B" }, SITE),
      bountyPostText({ kind: "revoked", target: "B" }, SITE),
    ].join(" ");
    expect(all).not.toMatch(/\d{3,5}(\.\d+)?\s*,\s*\d{3,5}/u);
  });
});
