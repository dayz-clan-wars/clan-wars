import { describe, it, expect } from "vitest";
import { parseTeleport } from "../src/teleport.js";

const ID = "D".repeat(40);

describe("parseTeleport", () => {
  it("reads a fast-travel line, building from/to as x, y(altitude), z", () => {
    const raw =
      `13:00:07 | Player "Steve" (id=${ID} pos=<100.0, 93.0, 300.0>) ` +
      "was teleported from: <1.0, 300.0, 2.0> to: <100.0, 93.0, 200.0>. Reason: Fast Travel";
    expect(parseTeleport(raw)).toEqual({
      dayzId: ID,
      gamertag: "Steve",
      from: { x: 1, y: 300, z: 2 },
      to: { x: 100, y: 93, z: 200 },
      reason: "Fast Travel",
    });
  });

  it("returns null without a 40-hex id", () => {
    const raw =
      `13:00:07 | Player "Steve" was teleported from: <1.0, 300.0, 2.0> ` +
      "to: <100.0, 93.0, 200.0>. Reason: Fast Travel";
    expect(parseTeleport(raw)).toBeNull();
  });
});
