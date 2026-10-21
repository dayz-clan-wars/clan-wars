import { describe, it, expect } from "vitest";
import { parseHit } from "../src/hit.js";
const V = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA", K = "BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB";
describe("parseHit", () => {
  it("a player's hit: attacker anchored on their id, HP after, damage, body part", () => {
    expect(parseHit(`10:00:00 | Player "Vic" (id=${V} pos=<1.0, 2.0, 3.0>)[HP: 61.9] hit by Player "Kil" (id=${K} pos=<4.0, 5.0, 6.0>) into Torso(1) for 38.1 damage (Bullet_556x45) with M4A1 from 12.3 meters`))
      .toEqual({ victimDayzId: V, victimGamertag: "Vic", victimHp: 61.9, attackerType: "player", attackerDayzId: K, attackerGamertag: "Kil", attackerLabel: null, cause: null, damage: 38.1, bodyPart: "Torso", weapon: "M4A1", distanceM: 12.3, victimPos: { x: 1, y: 3, z: 2 }, attackerPos: { x: 4, y: 6, z: 5 } });
  });
  it("⚠️ a hit from a player who is (DEAD) themselves is still that player's hit", () => {
    expect(parseHit(`10:00:00 | Player "Vic" (id=${V} pos=<1.0, 2.0, 3.0>)[HP: 20.5] hit by Player "Kil" (DEAD) (id=${K} pos=<4.0, 5.0, 6.0>) into Torso(1) for 38.59 damage (Bullet_9x19) with SCR 17`))
      .toMatchObject({ attackerType: "player", attackerDayzId: K, weapon: "SCR 17", distanceM: null });
  });
  it("an infected's hit", () => {
    expect(parseHit(`12:26:14 | Player "Vic" (id=${V} pos=<1.0, 2.0, 3.0>)[HP: 92.35] hit by Infected into Torso(1) for 7.65 damage (MeleeInfected)`))
      .toMatchObject({ victimDayzId: V, victimHp: 92.35, attackerType: "infected", attackerDayzId: null, attackerLabel: "Infected", damage: 7.65, bodyPart: "Torso", weapon: null, distanceM: null });
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
  it("keeps both players' positions — altitude is y, and pos=<x, z, alt> puts it LAST", () => {
    const h = parseHit(`17:24:38 | Player "Vic" (id=${V} pos=<101.0, 95.0, 998.6>)[HP: 71.6] hit by Player "Kil" (id=${K} pos=<99.3, 93.2, 998.6>) into Torso(21) for 28.3 damage (Bullet_556x45) with M4-A1 from 2.6 meters`)!;
    expect(h.victimPos).toEqual({ x: 101, y: 998.6, z: 95 });
    expect(h.attackerPos).toEqual({ x: 99.3, y: 998.6, z: 93.2 });
  });
  it("⚠️ the Hub's altitude parses — an ALT_MAX below 1000 would blind the Hub rule silently", () => {
    const h = parseHit(`10:00:00 | Player "Vic" (id=${V} pos=<100.0, 93.0, 997.5>)[HP: 50] hit by Player "Kil" (id=${K} pos=<100.0, 93.0, 997.5>) into Torso(1) for 5 damage (MeleeFist)`)!;
    expect(h.victimPos?.y).toBe(997.5);
  });
  it("a non-player attacker has no position", () => {
    expect(parseHit(`10:00:00 | Player "Vic" (id=${V} pos=<1.0, 2.0, 3.0>)[HP: 50] hit by Infected into Torso(1) for 5 damage (MeleeInfected)`)!.attackerPos).toBeNull();
  });
  it("⚠️ a gamertag carrying pos=<…> cannot move its owner onto the Hub", () => {
    const h = parseHit(`10:00:00 | Player "x pos=<100.0, 93.0, 998.0>" (id=${V} pos=<5000.0, 5000.0, 300.0>)[HP: 50] hit by Player "y pos=<100.0, 93.0, 998.0>" (id=${K} pos=<5001.0, 5000.0, 300.0>) into Torso(1) for 5 damage (MeleeFist)`)!;
    expect(h.victimPos).toEqual({ x: 5000, y: 300, z: 5000 });
    expect(h.attackerPos).toEqual({ x: 5001, y: 300, z: 5000 });
  });
  it("multi-word animal labels are kept whole", () => {
    expect(parseHit(`19:35:14 | Player "Vic" (id=${V} pos=<1.0, 2.0, 3.0>)[HP: 71.59] hit by German Shepherd into Head(0) for 10 damage (MeleeWolf)`))
      .toMatchObject({ attackerType: "environment", attackerLabel: "German Shepherd", damage: 10, bodyPart: "Head" });
    expect(parseHit(`10:00:00 | Player "Vic" (id=${V} pos=<1.0, 2.0, 3.0>)[HP: 80] hit by Brown Bear into Torso(1) for 20 damage (MeleeBear)`)?.attackerLabel).toBe("Brown Bear");
    expect(parseHit(`10:00:00 | Player "Vic" (id=${V} pos=<1.0, 2.0, 3.0>)[HP: 93] hit by Doberman into Head(0) for 3.5 damage (MeleeWolf)`)?.attackerLabel).toBe("Doberman");
    // A label that runs to the end of the line keeps no trailing space.
    expect(parseHit(`10:00:00 | Player "Vic" (id=${V} pos=<1.0, 2.0, 3.0>)[HP: 93] hit by Brown Bear `)?.attackerLabel).toBe("Brown Bear");
  });
  it("a vehicle with no driver: the label is the vehicle class, not 'NO'", () => {
    expect(parseHit(`20:58:42 | Player "Vic" (id=${V} pos=<1.0, 2.0, 3.0>)[HP: 53.2977] hit by NO DRIVER with TransportHit (Motorbike_02_Yellow)`))
      .toMatchObject({ attackerType: "environment", attackerLabel: "Motorbike_02_Yellow", cause: "TransportHit" });
  });
  it("a driven vehicle: the player is the attacker and the weapon carries the class", () => {
    expect(parseHit(`10:00:00 | Player "Vic" (id=${V} pos=<1.0, 2.0, 3.0>)[HP: 70] hit by Player "Kil" (id=${K} pos=<4.0, 5.0, 6.0>) with TransportHit (Motorbike_02_Red)`))
      .toMatchObject({ attackerType: "player", attackerDayzId: K, weapon: "TransportHit (Motorbike_02_Red)" });
  });
  it("a non-player hit keeps its `with` tail as cause", () => {
    expect(parseHit(`12:32:01 | Player "Vic" (id=${V} pos=<1.0, 2.0, 3.0>)[HP: 99.85] hit by Fence with BarbedWireHit`)).toMatchObject({ attackerLabel: "Fence", cause: "BarbedWireHit" });
    expect(parseHit(`10:00:00 | Player "Vic" (id=${V} pos=<1.0, 2.0, 3.0>)[HP: 90] hit by Infected into Torso(1) for 5 damage (MeleeInfected)`)).toMatchObject({ attackerLabel: "Infected", cause: null });
  });
  it("other existing labels are unchanged", () => {
    for (const label of ["BearTrap", "TripwireTrap", "Fireplace", "ChickenBreastMeat", "explosion"])
      expect(parseHit(`10:00:00 | Player "Vic" (id=${V} pos=<1.0, 2.0, 3.0>)[HP: 90] hit by ${label} with SomeHit`)?.attackerLabel).toBe(label);
  });
});
