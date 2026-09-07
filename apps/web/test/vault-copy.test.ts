import { describe, it, expect } from "vitest";
import { VAULT_RESULT_COPY, VAULT_INTRO, vaultCode } from "../lib/vault-copy";

describe("vault result copy", () => {
  it("has a non-empty sentence for every code", () => {
    for (const [k, v] of Object.entries(VAULT_RESULT_COPY)) {
      expect(k, k).toMatch(/^[a-z-]+\.[a-z-]+$/u);
      expect(v.trim().length, k).toBeGreaterThan(0);
    }
  });
  it("builds keys the table has", () => {
    expect(VAULT_RESULT_COPY[vaultCode("add", "bad-code")]).toBeDefined();
    expect(VAULT_RESULT_COPY[vaultCode("rotate", "ok")]).toBeDefined();
    expect(VAULT_RESULT_COPY[vaultCode("reveal", "not-visible")]).toBeDefined();
    expect(VAULT_RESULT_COPY[vaultCode("confirm", "gone")]).toBeDefined();
    expect(VAULT_RESULT_COPY[vaultCode("delete", "unconfirmed")]).toBeDefined();
  });
  it("misses on a prototype key", () => {
    expect(Object.hasOwn(VAULT_RESULT_COPY, "__proto__")).toBe(false);
  });
  it("never says faction", () => {
    for (const [k, v] of Object.entries(VAULT_RESULT_COPY)) {
      expect(v, k).not.toMatch(/faction/iu);
    }
    expect(VAULT_INTRO).not.toMatch(/faction/iu);
  });
  /**
   * A code must never be guessable from its own copy: no 4-digit run may
   * appear anywhere in the table, or in the intro shown above the lock
   * list — a copy string is the one place a real vault code could leak
   * without ever going through `/api/vault/reveal`.
   */
  it("no copy string contains a 4-digit run", () => {
    for (const [k, v] of Object.entries(VAULT_RESULT_COPY)) {
      expect(v, k).not.toMatch(/\d{4}/u);
    }
    expect(VAULT_INTRO).not.toMatch(/\d{4}/u);
  });
});
