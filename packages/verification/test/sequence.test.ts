import { describe, it, expect } from "vitest";
import { generateSequence, isExpired } from "../src/sequence.js";
import { safeVerificationEmotes } from "@factions/domain";

/** Deterministic rng cycling through fixed values. */
function seeded(values: number[]): () => number {
  let i = 0;
  return () => values[i++ % values.length]!;
}

describe("generateSequence", () => {
  it("returns the requested length", () => {
    expect(generateSequence(seeded([0, 0, 0]), 3)).toHaveLength(3);
  });

  it("defaults to length 4", () => {
    // Length is a security parameter, not a UX one. Matching holds on
    // mismatch, so a challenge completes iff its sequence is a SUBSEQUENCE of
    // what the player performed — a run of n distinct emotes therefore covers
    // C(n, length) sequences at once, against every live challenge at once.
    // At length 3 the pool offers 29*28*27 = 21,924 sequences and the emote
    // budget's C(budget, 3) runs cover ~1% of them per challenge. Length 4
    // takes the space to 570,024 and the coverage to ~0.01%.
    expect(generateSequence(seeded([0, 0, 0]))).toHaveLength(4);
  });

  it("never repeats an emote within a sequence", () => {
    for (let i = 0; i < 200; i++) {
      const seq = generateSequence(Math.random);
      expect(new Set(seq).size).toBe(seq.length);
    }
  });

  it("draws only from the safe pool", () => {
    const safe = new Set(safeVerificationEmotes().map((e) => e.token));
    for (let i = 0; i < 200; i++) {
      for (const token of generateSequence(Math.random)) expect(safe.has(token)).toBe(true);
    }
  });

  it("is deterministic for a given rng", () => {
    expect(generateSequence(seeded([0, 0, 0]), 3)).toEqual(generateSequence(seeded([0, 0, 0]), 3));
  });

  it("caps at the pool size rather than looping forever", () => {
    const poolSize = safeVerificationEmotes().length;
    expect(generateSequence(Math.random, poolSize + 5)).toHaveLength(poolSize);
  });
});

describe("isExpired", () => {
  it("is false before the expiry instant", () => {
    expect(isExpired({ expiresAt: new Date(1_000) }, new Date(999))).toBe(false);
  });

  it("is false exactly at the expiry instant", () => {
    expect(isExpired({ expiresAt: new Date(1_000) }, new Date(1_000))).toBe(false);
  });

  it("is true after the expiry instant", () => {
    expect(isExpired({ expiresAt: new Date(1_000) }, new Date(1_001))).toBe(true);
  });
});
