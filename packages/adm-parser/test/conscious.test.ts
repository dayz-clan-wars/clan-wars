import { describe, it, expect } from "vitest";
import { parseConscious } from "../src/conscious.js";

const V = "A".repeat(40);

describe("parseConscious", () => {
  it("parses a player waking up", () => {
    const raw = `12:57:10 | Player "Vic" (id=${V} pos=<1, 2, 3>) regained consciousness`;
    expect(parseConscious(raw)).toEqual({ dayzId: V, gamertag: "Vic" });
  });
  it("ignores a DEAD player", () => {
    const raw = `12:57:10 | Player "Vic" (DEAD) (id=${V} pos=<1, 2, 3>) regained consciousness`;
    expect(parseConscious(raw)).toBeNull();
  });
  it("cannot be forged by a gamertag", () => {
    const raw = `12:57:10 | Player "x (id=${V} pos=<1, 2, 3>) regained consciousness" (id=${V} pos=<1, 2, 3>) is connected`;
    expect(parseConscious(raw)).toBeNull();
  });
});
