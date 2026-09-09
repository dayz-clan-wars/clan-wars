import { describe, it, expect } from "vitest";
import { parseHit } from "../src/hit.js";
const V = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA", K = "BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB";
describe("parseHit", () => {
  it("a player's hit: attacker anchored on their id, HP after, damage, body part", () => {
    expect(parseHit(`10:00:00 | Player "Vic" (id=${V} pos=<1.0, 2.0, 3.0>)[HP: 61.9] hit by Player "Kil" (id=${K} pos=<4.0, 5.0, 6.0>) into Torso(1) for 38.1 damage (Bullet_556x45) with M4A1 from 12.3 meters`))
      .toEqual({ victimDayzId: V, victimGamertag: "Vic", victimHp: 61.9, attackerType: "player", attackerDayzId: K, attackerGamertag: "Kil", attackerLabel: null, damage: 38.1, bodyPart: "Torso" });
  });
  it("an infected's hit", () => {
    expect(parseHit(`12:26:14 | Player "Vic" (id=${V} pos=<1.0, 2.0, 3.0>)[HP: 92.35] hit by Infected into Torso(1) for 7.65 damage (MeleeInfected)`))
      .toMatchObject({ victimDayzId: V, victimHp: 92.35, attackerType: "infected", attackerDayzId: null, attackerLabel: "Infected", damage: 7.65, bodyPart: "Torso" });
  });
  it("the environment: a fall, a fence, a car — the class name is the label", () => {
    expect(parseHit(`20:43:56 | Player "Vic" (id=${V} pos=<1.0, 2.0, 3.0>)[HP: 65.3546] hit by FallDamageHealth`))
      .toMatchObject({ attackerType: "environment", attackerLabel: "FallDamageHealth", victimHp: 65.3546, damage: null, bodyPart: null });
    expect(parseHit(`12:32:01 | Player "Vic" (id=${V} pos=<1.0, 2.0, 3.0>)[HP: 99.85] hit by Fence with BarbedWireHit`)?.attackerLabel).toBe("Fence");
    expect(parseHit(`19:36:50 | Player "Vic" (id=${V} pos=<1.0, 2.0, 3.0>)[HP: 61.908] hit by CivilianSedan_Wine with TransportHit`)?.attackerLabel).toBe("CivilianSedan_Wine");
  });
  it("an animal's hit is the environment with the animal's class as the label", () => {
    expect(parseHit(`10:00:00 | Player "Vic" (id=${V} pos=<1.0, 2.0, 3.0>)[HP: 40] hit by Animal_CanisLupus_Grey into Torso(1) for 20 damage (MeleeWolf)`))
      .toMatchObject({ attackerType: "environment", attackerLabel: "Animal_CanisLupus_Grey" });
  });
  it("a corpse being hit is not a hit; a line without `hit by` is nothing", () => {
    expect(parseHit(`10:00:00 | Player "Vic" (DEAD) (id=${V} pos=<1.0, 2.0, 3.0>)[HP: 0] hit by Infected into Torso(1) for 5 damage (MeleeInfected)`)).toBeNull();
    expect(parseHit(`10:00:00 | Player "Vic" (id=${V} pos=<1.0, 2.0, 3.0>)`)).toBeNull();
  });
  it("⚠️ a gamertag that says 'hit by Player' does not forge an attacker", () => {
    expect(parseHit(`10:00:00 | Player "x hit by Player y" (id=${V} pos=<1.0, 2.0, 3.0>)[HP: 50] hit by Infected into Torso(1) for 5 damage (MeleeInfected)`))
      .toMatchObject({ victimDayzId: V, victimGamertag: "x hit by Player y", attackerType: "infected", attackerDayzId: null });
  });
});
