import { describe, it, expect } from "vitest";
import { parseRosterHeader, isRosterTerminator, parsePlayerListEntry } from "../src/index.js";

const ID = "13D36CE8B8FEB71D08B02F15FBFD8A7E2640FAD7";

describe("parseRosterHeader", () => {
  it("reads the player count", () => {
    expect(parseRosterHeader("13:00:07 | ##### PlayerList log: 2 players")).toEqual({ count: 2 });
  });
  it("handles a zero-player dump", () => {
    expect(parseRosterHeader("13:00:07 | ##### PlayerList log: 0 players")).toEqual({ count: 0 });
  });
  it("returns null on a normal line", () => {
    expect(parseRosterHeader('Player "A" (id=AB) is connected')).toBeNull();
  });
});

describe("isRosterTerminator", () => {
  it("matches the closing marker", () => {
    expect(isRosterTerminator("13:00:07 | #####")).toBe(true);
  });
  it("does not match the header", () => {
    expect(isRosterTerminator("13:00:07 | ##### PlayerList log: 2 players")).toBe(false);
  });
});

describe("parsePlayerListEntry", () => {
  it("parses a body line ending at the closing paren", () => {
    const raw = `13:00:07 | Player "LowerMarrow774" (id=${ID} pos=<9958.4, 7440.6, 176.4>)`;
    expect(parsePlayerListEntry(raw)).toEqual({
      gamertag: "LowerMarrow774",
      dayzId: ID,
      pos: { x: 9958.4, y: 176.4, z: 7440.6 },
    });
  });

  it("returns null when a verb follows the paren", () => {
    const raw = `13:00:07 | Player "LowerMarrow774" (id=${ID} pos=<9958.4, 7440.6, 176.4>) folded Flag Pole`;
    expect(parsePlayerListEntry(raw)).toBeNull();
  });

  it("returns null for a hit line, which also has trailing content", () => {
    const raw = `13:01:05 | Player "LowerMarrow774" (id=${ID} pos=<9958.3, 7440.8, 176.3>)[HP: 99.1563] hit by BarrelHoles_Yellow with FireDamage`;
    expect(parsePlayerListEntry(raw)).toBeNull();
  });

  it("tolerates trailing whitespace", () => {
    const raw = `13:00:07 | Player "LowerMarrow774" (id=${ID} pos=<9958.4, 7440.6, 176.4>)   `;
    expect(parsePlayerListEntry(raw)).not.toBeNull();
  });
});
