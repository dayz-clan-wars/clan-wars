import { describe, it, expect } from "vitest";
import { voteThreshold, ROLE_RANK, canSeeLock, NICKNAME_MAX, nicknameFor, randomVaultCode } from "../src/leadership";

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
  it("zero-pads to VAULT_CODE_DIGITS from the rng", () => {
    expect(randomVaultCode(() => 0)).toBe("0000");
    expect(randomVaultCode(() => 0.9999)).toBe("9999");
  });
  it("always returns VAULT_CODE_DIGITS digits", () => {
    for (let i = 0; i < 200; i++) {
      expect(randomVaultCode()).toMatch(/^\d{4}$/u);
    }
  });
});
