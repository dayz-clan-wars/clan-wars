import { describe, it, expect } from "vitest";
import { parseUnconscious } from "../src/unconscious.js";
const V = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
describe("parseUnconscious", () => {
  it("going down", () => {
    expect(parseUnconscious(`16:02:44 | Player "Vic" (id=${V} pos=<1.0, 2.0, 3.0>) is unconscious`)).toEqual({ dayzId: V, gamertag: "Vic", disconnecting: false });
  });
  it("the combat-log form", () => {
    expect(parseUnconscious(`16:02:44 | Player "Vic" (id=${V} pos=<1.0, 2.0, 3.0>) is disconnecting while being unconscious`)).toEqual({ dayzId: V, gamertag: "Vic", disconnecting: true });
  });
  it("not: waking up, or a corpse", () => {
    expect(parseUnconscious(`16:03:00 | Player "Vic" (id=${V} pos=<1.0, 2.0, 3.0>) regained consciousness`)).toBeNull();
    expect(parseUnconscious(`16:03:12 | Player "Vic" (DEAD) (id=${V} pos=<1.0, 2.0, 3.0>) is unconscious`)).toBeNull();
  });
});
