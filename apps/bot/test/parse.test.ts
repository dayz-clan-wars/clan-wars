import { describe, it, expect } from "vitest";
import { idOf, parseScope } from "../src/commands/parse.js";

describe("parseScope", () => {
  it("defaults to the current season", () => {
    expect(parseScope(null)).toEqual({ kind: "current" });
    expect(parseScope("")).toEqual({ kind: "current" });
    expect(parseScope("current")).toEqual({ kind: "current" });
  });

  it("reads all-time and a season number", () => {
    expect(parseScope("all")).toEqual({ kind: "all" });
    expect(parseScope("2")).toEqual({ kind: "season", number: 2 });
  });

  /** ⚠️ Anything else is the current season, not a throw: this parses a client-supplied string. */
  it("falls back to the current season for anything it does not recognise", () => {
    for (const raw of ["-1", "0", "1.5", "season two", "  "]) expect(parseScope(raw)).toEqual({ kind: "current" });
  });
});

describe("idOf", () => {
  it("reads a plain positive integer", () => {
    expect(idOf("1")).toBe(1);
    expect(idOf("4210")).toBe(4210);
  });

  it("is null for nothing to read", () => {
    for (const raw of [null, "", "   "]) expect(idOf(raw)).toBeNull();
  });

  /**
   * ⚠️ The reason this function matches a regex instead of calling
   * `Number()`: every one of these coerces to a positive integer that
   * passes `Number.isInteger`, and each would then be sent to the roster as
   * a row id the player never named. An option marked
   * `setAutocomplete(true)` still delivers whatever the player TYPED rather
   * than what they picked, so all sixteen call sites on this branch —
   * `lock:`, `pin:`, `invite:`, `request:`, `pass:` — take arbitrary text.
   */
  it("rejects the coercions Number() would accept", () => {
    expect(Number("9e2")).toBe(900); // the trap, stated so the test explains itself
    for (const raw of ["9e2", "0x10", "1e3", " 12", "12 ", "+7", "1_0"]) {
      expect(idOf(raw), `idOf(${JSON.stringify(raw)}) must not coerce`).toBeNull();
    }
  });

  it("is null for zero, a negative, a fraction and plain text", () => {
    for (const raw of ["0", "-1", "1.5", "abc", "NaN", "Infinity"]) expect(idOf(raw)).toBeNull();
  });
});
