import { describe, it, expect } from "vitest";
import { parseStructure } from "../src/structure.js";
import { parseLine, eventTypeFor } from "../src/parse-line.js";

const ID = "A".repeat(40);

describe("parseStructure", () => {
  it("reads a built part with its structure, tool and the player's position", () => {
    const raw = `10:00:00 | Player "A" (id=${ID} pos=<1.0, 2.0, 3.0>)Built wall_base_down on Fence with Hammer`;
    expect(parseStructure(raw)).toEqual({ gamertag: "A", dayzId: ID, action: "built", part: "wall_base_down", structure: "Fence", tool: "Hammer", pos: { x: 1, y: 3, z: 2 } });
  });
  it("reads a dismantle without a tool", () => {
    const raw = `10:00:00 | Player "A" (id=${ID} pos=<1.0, 2.0, 3.0>)Dismantled gate_base from Fence`;
    expect(parseStructure(raw)).toMatchObject({ action: "dismantled", part: "gate_base", structure: "Fence", tool: null });
  });
  it("returns null for the flag pole, which flagpole.ts owns", () => {
    expect(parseStructure(`10:00:00 | Player "A" (id=${ID} pos=<1.0, 2.0, 3.0>)Built base on Flag Pole with Hammer`)).toBeNull();
  });
  it("returns null without a position — the alert needs a zone", () => {
    expect(parseStructure(`10:00:00 | Player "A" (id=${ID})Built wall_base_down on Fence`)).toBeNull();
  });
  it("⚠️ anchors after the identity block: a gamertag carrying the words is not a build", () => {
    expect(parseStructure(`10:00:00 | Player "Built gate on Fence" (id=${ID} pos=<1.0, 2.0, 3.0>) has connected`)).toBeNull();
  });
  it("is a ParsedLine kind with an event type", () => {
    const [line] = parseLine(`10:00:00 | Player "A" (id=${ID} pos=<1.0, 2.0, 3.0>)Built gate on Fence with Hammer`);
    expect(line).toMatchObject({ kind: "structure" });
    expect(eventTypeFor(line!)).toBe("base.built");
  });
});
