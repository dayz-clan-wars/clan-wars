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

  it("defaults to length 3", () => {
    expect(generateSequence(seeded([0, 0, 0]))).toHaveLength(3);
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
