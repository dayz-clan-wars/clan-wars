import { describe, it, expect } from "vitest";
import { EMOTE_DICTIONARY, emoteToken, emoteLabel, safeVerificationEmotes } from "../src/emotes.js";

describe("emote dictionary", () => {
  it("has a unique token for every entry", () => {
    const tokens = EMOTE_DICTIONARY.map((e) => e.token);
    expect(new Set(tokens).size).toBe(tokens.length);
  });

  it("has a unique label for every entry", () => {
    const labels = EMOTE_DICTIONARY.map((e) => e.label);
    expect(new Set(labels).size).toBe(labels.length);
  });

  it("resolves a label to its token, case-insensitively", () => {
    expect(emoteToken("salute")).toBe("EmoteSalute");
    expect(emoteToken("SALUTE")).toBe("EmoteSalute");
  });

  it("resolves a token back to its label", () => {
    expect(emoteLabel("EmoteSalute")).toBe("salute");
  });

  it("returns undefined for an unknown label or token", () => {
    expect(emoteToken("nonsense")).toBeUndefined();
    expect(emoteLabel("EmoteNonsense")).toBeUndefined();
  });

  it("excludes the emotes that dominate natural play from the safe pool", () => {
    const safe = safeVerificationEmotes().map((e) => e.token);
    // EmoteSitA is 77% of every emote line in the production export.
    expect(safe).not.toContain("EmoteSitA");
    expect(safe).not.toContain("EmoteSitB");
    expect(safe).not.toContain("EmoteCampfireSit");
    expect(safe).not.toContain("EmoteLyingDown");
  });

  it("excludes emotes that carry a gameplay penalty", () => {
    const safe = safeVerificationEmotes().map((e) => e.token);
    expect(safe).not.toContain("EmoteSuicide");
    expect(safe).not.toContain("EmoteVomit");
  });

  it("leaves a pool large enough that a 3-emote sequence is not guessable", () => {
    const n = safeVerificationEmotes().length;
    // n*(n-1)*(n-2) distinct ordered sequences; require at least 10k.
    expect(n * (n - 1) * (n - 2)).toBeGreaterThan(10_000);
  });
});
