import { describe, it, expect } from "vitest";
import { EMOTE_DICTIONARY, emoteToken, emoteLabel, safeVerificationEmotes } from "../src/emotes.js";

// one-life's PUBLISHED list, adopted whole. ⚠️ Not an empirically-working set:
// the same false claim used to sit here and in emotes.ts, and 12 of these 24
// have never appeared in this project's live data — `EmoteMove` among them,
// which blocked a real /link on 2026-09-01. See the docstring in emotes.ts for
// what is and is not evidence here.
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

  it("⚠️ the pool is one-life's list, adopted on trust rather than on local evidence", () => {
    // This test exists to make the provenance a fact the suite states rather
    // than a claim in a comment — comments are what got this wrong twice.
    // Twelve of the 24 had never appeared in this project's live data as of
    // 2026-09-02, so the pool cannot be described as locally verified.
    //
    // Deliberately NOT asserted against live data: the suite must not need a
    // populated `events` table, and a token's absence from a small sample is
    // not evidence against it. See emotes.ts for the query that regenerates
    // the real counts.
    const unverifiedLocally = [
      "EmoteHeart", "EmoteThumb", "EmoteNod", "EmoteShake", "EmoteShrug",
      "EmoteTimeout", "EmoteCome", "EmoteMove", "EmoteSilent", "EmoteWatching",
      "EmoteThroat", "EmoteRPSRandom",
    ];
    const safe = safeVerificationEmotes().map((e) => e.token);
    // They are all still offered — absence of evidence is not a demotion.
    for (const token of unverifiedLocally) expect(safe).toContain(token);
    // And they really are a strict subset, so the count in the docstring and
    // the count here cannot silently disagree about which list is which.
    expect(unverifiedLocally.length).toBe(12);
    expect(safe.length).toBe(24);
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
