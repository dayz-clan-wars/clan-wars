import { describe, it, expect } from "vitest";
import { EMOTE_DICTIONARY, emoteToken, emoteLabel, safeVerificationEmotes } from "../src/emotes.js";

// one-life's list, which is the empirically-working set: every token here has
// been performed by a real player completing a real /link in production.
const ONE_LIFE_SAFE = [
  "EmoteSalute", "EmoteSurrender", "EmoteGreeting", "EmoteClap", "EmoteHeart",
  "EmotePoint", "EmotePointSelf", "EmoteThumb", "EmoteThumbDown", "EmoteNod",
  "EmoteShake", "EmoteDance", "EmoteFacepalm", "EmoteShrug", "EmoteTimeout",
  "EmoteLookAtMe", "EmoteListening", "EmoteCome", "EmoteMove", "EmoteSilent",
  "EmoteWatching", "EmoteThroat", "EmoteRPSRandom", "EmoteTauntElbow",
];

describe("emote dictionary", () => {
  it("has a unique token for every entry", () => {
    const tokens = EMOTE_DICTIONARY.map((e) => e.token);
    expect(new Set(tokens).size).toBe(tokens.length);
  });

  it("has a unique label for every entry, case-folded", () => {
    // Case-FOLDED, because emoteToken() lowercases before lookup. Two labels
    // differing only by case would collide in that Map with the last one
    // silently winning, and an exact-string check would not catch it.
    const labels = EMOTE_DICTIONARY.map((e) => e.label.toLowerCase());
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

  it("offers exactly one-life's safe set", () => {
    expect(safeVerificationEmotes().map((e) => e.token).sort())
      .toEqual([...ONE_LIFE_SAFE].sort());
  });

  it("never offers an emote that is not confirmed on the wheel", () => {
    // The five this project added beyond one-life. EmoteSOS is the one that
    // reached a player and could not be performed.
    for (const token of ["EmoteSOS", "EmoteHold", "EmoteTaunt", "EmoteTauntKiss", "EmoteTauntThink"]) {
      expect(safeVerificationEmotes().map((e) => e.token)).not.toContain(token);
    }
  });

  it("still LABELS the excluded tokens, so the parser can name them", () => {
    // They stay in the dictionary; only the safe flag changes. Dropping them
    // entirely would make real emote lines unlabelable.
    expect(emoteLabel("EmoteSOS")).toBe("SOS");
    expect(EMOTE_DICTIONARY.find((e) => e.token === "EmoteSOS")?.safe).toBe(false);
  });
});
