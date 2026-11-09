import { describe, it, expect } from "vitest";
import { atHub, hubKillDiscredited, readVec3 } from "../src/hub";
import { HUB_COMBAT_FROM } from "../src/rules";
import { HUB_POSITION } from "../src/rules";

const HUB = { x: 100, y: 998.6, z: 93 };
const GROUND = { x: 100, y: 310, z: 93 };

describe("atHub", () => {
  it("every Hub door (x 86–114, z 92–111, y 998.6) is inside", () => {
    for (const [x, z] of [[86, 92], [114, 92], [86, 111], [114, 111], [100, 93]]) expect(atHub({ x: x!, y: 998.6, z: z! })).toBe(true);
  });
  it("⚠️ the ground directly below the Hub is outside: the cylinder has a floor", () => {
    expect(atHub(GROUND)).toBe(false);
    expect(atHub({ ...HUB, y: 899.9 })).toBe(false);
    expect(atHub({ ...HUB, y: 900 })).toBe(true);
  });
  it("100 m out is inside, 100.1 m is outside", () => {
    expect(atHub({ x: HUB_POSITION.x + 100, y: 998, z: HUB_POSITION.z })).toBe(true);
    expect(atHub({ x: HUB_POSITION.x + 100.1, y: 998, z: HUB_POSITION.z })).toBe(false);
  });
  it("no position is never inside", () => expect(atHub(null)).toBe(false));
});

describe("readVec3", () => {
  it("reads a stored payload vector", () => expect(readVec3({ x: 1, y: 2, z: 3 })).toEqual({ x: 1, y: 2, z: 3 }));
  it("rejects anything that is not three finite numbers", () => {
    for (const v of [null, undefined, "1,2,3", { x: 1, y: 2 }, { x: "1", y: 2, z: 3 }, { x: NaN, y: 2, z: 3 }]) expect(readVec3(v)).toBeNull();
  });
});

describe("hubKillDiscredited", () => {
  const before = new Date(HUB_COMBAT_FROM.getTime() - 1);
  it("a kill in the zone from HUB_COMBAT_FROM on is discredited", () => {
    expect(hubKillDiscredited(true, HUB_COMBAT_FROM)).toBe(true);
    expect(hubKillDiscredited(true, new Date(HUB_COMBAT_FROM.getTime() + 86_400_000))).toBe(true);
  });
  it("⚠️ a kill in the zone before the rule existed is not — the rule is not retroactive", () => {
    expect(hubKillDiscredited(true, before)).toBe(false);
  });
  it("a kill outside the zone never is", () => {
    expect(hubKillDiscredited(false, HUB_COMBAT_FROM)).toBe(false);
    expect(hubKillDiscredited(false, before)).toBe(false);
  });
});
