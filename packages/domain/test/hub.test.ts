import { describe, it, expect } from "vitest";
import { atHub, hubOffence, readVec3 } from "../src/hub";
import { HUB_POSITION, HUB_TRAP_CLASSES } from "../src/rules";

const A = "A".repeat(40), B = "B".repeat(40);
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

describe("hubOffence", () => {
  const hit = (over: Record<string, unknown> = {}) => ({
    victimDayzId: B, victimGamertag: "Bee", attackerType: "player", attackerDayzId: A, attackerGamertag: "Ay",
    victimPos: HUB, attackerPos: HUB, ...over,
  });
  it("a player hit at the Hub: the attacker offends against the victim", () => {
    expect(hubOffence("player.hit", hit())).toEqual({ offender: A, gamertag: "Ay", victim: B });
  });
  it("either party inside is enough", () => {
    expect(hubOffence("player.hit", hit({ attackerPos: GROUND }))).not.toBeNull();
    expect(hubOffence("player.hit", hit({ victimPos: GROUND }))).not.toBeNull();
    expect(hubOffence("player.hit", hit({ victimPos: GROUND, attackerPos: GROUND }))).toBeNull();
  });
  it("infected, environment and self-inflicted hits are never offences", () => {
    expect(hubOffence("player.hit", hit({ attackerType: "infected", attackerDayzId: null }))).toBeNull();
    expect(hubOffence("player.hit", hit({ attackerType: "environment", attackerDayzId: null }))).toBeNull();
    expect(hubOffence("player.hit", hit({ attackerDayzId: B }))).toBeNull();
  });
  it("a kill at the Hub: the killer offends", () => {
    expect(hubOffence("player.killed", { victimDayzId: B, killerDayzId: A, killerGamertag: "Ay", victimPos: HUB, killerPos: GROUND }))
      .toEqual({ offender: A, gamertag: "Ay", victim: B });
  });
  it("a trap placed at the Hub offends with no victim; a tent does not", () => {
    for (const itemClass of HUB_TRAP_CLASSES) {
      expect(hubOffence("item.placed", { dayzId: A, gamertag: "Ay", itemClass, pos: HUB })).toEqual({ offender: A, gamertag: "Ay", victim: null });
    }
    expect(hubOffence("item.placed", { dayzId: A, gamertag: "Ay", itemClass: "LargeTent", pos: HUB })).toBeNull();
    expect(hubOffence("item.placed", { dayzId: A, gamertag: "Ay", itemClass: "BearTrap", pos: GROUND })).toBeNull();
  });
  it("any other event type is never an offence", () => expect(hubOffence("player.died", hit())).toBeNull());
});
