import { describe, it, expect } from "vitest";
import { voteThreshold, ROLE_RANK, canSeeLock, NICKNAME_MAX, nicknameFor, randomVaultCode, VAULT_CODE_RE } from "../src/leadership";

describe("voteThreshold", () => {
  it("is ceil(2/3 x electorate size), from VOTE_THRESHOLD (spec §13)", () => {
    expect(voteThreshold(9)).toBe(6);
    expect(voteThreshold(8)).toBe(6);
    expect(voteThreshold(1)).toBe(1);
    expect(voteThreshold(0)).toBe(0);
  });
});

describe("nicknameFor", () => {
  it("prefixes the tag, uppercased, and slices the gamertag so the whole fits NICKNAME_MAX", () => {
    const n = nicknameFor("A".repeat(40), "BEAR");
    expect(n).toHaveLength(NICKNAME_MAX);
    expect(n.startsWith("[BEAR] ")).toBe(true);
  });
  it("renders the bare gamertag when there is no tag", () => {
    expect(nicknameFor("Wolfie", null)).toBe("Wolfie");
  });
  it("slices a bare gamertag over NICKNAME_MAX too, so it never drifts from Discord's own truncation", () => {
    const n = nicknameFor("A".repeat(40), null);
    expect(n).toHaveLength(NICKNAME_MAX);
    expect(n).toBe("A".repeat(NICKNAME_MAX));
  });
  it("upper-cases a lowercase tag", () => {
    expect(nicknameFor("Wolfie", "bear")).toBe("[BEAR] Wolfie");
  });
});

describe("canSeeLock", () => {
  it("compares ROLE_RANK", () => {
    expect(canSeeLock("member", "officer")).toBe(false);
    expect(canSeeLock("officer", "member")).toBe(true);
  });
});

describe("randomVaultCode", () => {
  it("zero-pads to the shortest length from the rng by default", () => {
    expect(randomVaultCode(() => 0)).toBe("0000");
    expect(randomVaultCode(() => 0.9999)).toBe("9999");
  });
  it("always returns 4 digits by default — the one length every lock takes", () => {
    for (let i = 0; i < 200; i++) {
      expect(randomVaultCode()).toMatch(/^\d{4}$/u);
    }
  });
  it("returns the asked-for length, 4 to 6", () => {
    expect(randomVaultCode(() => 0, 5)).toBe("00000");
    expect(randomVaultCode(() => 0.999999, 6)).toBe("999999");
  });
  it("refuses a length outside 4 to 6", () => {
    expect(() => randomVaultCode(Math.random, 3)).toThrow(RangeError);
    expect(() => randomVaultCode(Math.random, 7)).toThrow(RangeError);
  });
});

describe("VAULT_CODE_RE", () => {
  it("takes 4, 5 and 6 digits and nothing else", () => {
    for (const ok of ["0000", "12345", "999999"]) expect(VAULT_CODE_RE.test(ok), ok).toBe(true);
    for (const bad of ["123", "1234567", "12a4", " 1234", "１２３４"]) expect(VAULT_CODE_RE.test(bad), bad).toBe(false);
  });
});
