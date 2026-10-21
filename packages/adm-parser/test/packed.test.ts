import { describe, it, expect } from "vitest";
import { parsePacked } from "../src/packed.js";

const V = "A".repeat(40);

describe("parsePacked", () => {
  it("parses a Large Tent, tolerating the trailing space", () => {
    const raw = `12:57:10 | Player "Vic" (id=${V} pos=<1.0, 2.0, 3.0>) packed Large Tent with Hands `;
    expect(parsePacked(raw)).toMatchObject({ dayzId: V, gamertag: "Vic", item: "Large Tent", pos: { x: 1, y: 3, z: 2 } });
  });
  it("parses a Car Tent without a trailing space", () => {
    const raw = `12:57:10 | Player "Vic" (id=${V} pos=<1, 2, 3>) packed Car Tent with Hands`;
    expect(parsePacked(raw)?.item).toBe("Car Tent");
  });
  it("parses an Improvised Shelter", () => {
    const raw = `12:57:10 | Player "Vic" (id=${V} pos=<1, 2, 3>) packed Improvised Shelter with Hands `;
    expect(parsePacked(raw)?.item).toBe("Improvised Shelter");
  });
  it("cannot be forged by a gamertag", () => {
    const raw = `12:57:10 | Player "x (id=${V} pos=<1, 2, 3>) packed Large Tent with Hands " (id=${V} pos=<1, 2, 3>) is connected`;
    expect(parsePacked(raw)).toBeNull();
  });
});
