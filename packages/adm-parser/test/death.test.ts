import { describe, it, expect } from "vitest";
import { parseDeath } from "../src/death.js";
const V = "A".repeat(40), K = "B".repeat(40);
describe("parseDeath", () => {
  it("reads a PvP kill with weapon and distance, both ids anchored", () => {
    expect(parseDeath(`10:00:00 | Player "Vic" (DEAD) (id=${V} pos=<1.0, 2.0, 3.0>) killed by Player "Kil" (id=${K} pos=<4.0, 5.0, 6.0>) with M4A1 from 153.4 meters`))
      .toEqual({ kind: "killed", victimDayzId: V, victimGamertag: "Vic", killerDayzId: K, killerGamertag: "Kil", weapon: "M4A1", distanceM: 153.4, victimPos: { x: 1, y: 3, z: 2 }, killerPos: { x: 4, y: 6, z: 5 } });
  });
  it("⚠️ a mutual kill — the killer is (DEAD) too — is still a kill by that player, never 'environment'", () => {
    expect(parseDeath(`13:41:04 | Player "Vic" (DEAD) (id=${V} pos=<1.0, 2.0, 3.0>) killed by Player "Kil" (DEAD) (id=${K} pos=<4.0, 5.0, 6.0>) with SCR 17 from 4.6558 meters`))
      .toEqual({ kind: "killed", victimDayzId: V, victimGamertag: "Vic", killerDayzId: K, killerGamertag: "Kil", weapon: "SCR 17", distanceM: 4.6558, victimPos: { x: 1, y: 3, z: 2 }, killerPos: { x: 4, y: 6, z: 5 } });
  });
  it("a grenade names no thrower: an explosion, not the environment", () => {
    expect(parseDeath(`17:44:37 | Player "Vic" (DEAD) (id=${V} pos=<1.0, 2.0, 3.0>) killed by 6-M7 Frag Grenade`)).toMatchObject({ kind: "died", cause: "explosion", entity: "6" });
    expect(parseDeath(`15:19:45 | Player "Vic" (DEAD) (id=${V} pos=<1.0, 2.0, 3.0>) killed by EGD-5 Frag Grenade`)).toMatchObject({ kind: "died", cause: "explosion" });
  });
  it("reads a PvP kill without distance (melee)", () => {
    expect(parseDeath(`10:00:00 | Player "Vic" (DEAD) (id=${V}) killed by Player "Kil" (id=${K}) with Knife`)).toMatchObject({ kind: "killed", weapon: "Knife", distanceM: null });
  });
  it.each([
    [`killed by Zmb_Male_Farmer`, "infected", "Zmb_Male_Farmer"], [`killed by Animal_UrsusArctos`, "bear", "Animal_UrsusArctos"],
    [`killed by Animal_CanisLupus_Grey`, "wolf", "Animal_CanisLupus_Grey"], [`killed by Animal_CapreolusCapreolus`, "animal", "Animal_CapreolusCapreolus"],
    [`killed by FallDamage`, "fall", "FallDamage"], [`killed by CivilianSedan`, "vehicle", "CivilianSedan"],
    [`killed by SomethingNew`, "environment", "SomethingNew"], [`bled out`, "bled_out", null], [`drowned`, "drowned", null],
    [`committed suicide`, "suicide", null], [`died.`, "died", null],
  ])("classifies '%s' as %s", (tail, cause, entity) => {
    expect(parseDeath(`10:00:00 | Player "Vic" (DEAD) (id=${V} pos=<1.0, 2.0, 3.0>) ${tail}`)).toEqual({ kind: "died", victimDayzId: V, victimGamertag: "Vic", cause, entity, water: null, energy: null, bleedSources: null });
  });
  it("reads the Stats> tail of a bare death — the evidence for what it died of", () => {
    expect(parseDeath(`16:06:05 | Player "Vic" (DEAD) (id=${V} pos=<6477.3, 11497.8, 189.1>) died. Stats> Water: 598.786 Energy: 0 Bleed sources: 1`))
      .toMatchObject({ kind: "died", cause: "died", water: 598.786, energy: 0, bleedSources: 1 });
  });
  it("a bare (DEAD) marker with no death verb is not a death", () => {
    expect(parseDeath(`10:00:00 | Player "Vic" (DEAD) (id=${V} pos=<1.0, 2.0, 3.0>)`)).toBeNull();
  });
  it("ignores a hit line and an unconscious line", () => {
    expect(parseDeath(`10:00:00 | Player "Vic" (DEAD) (id=${V}) hit by Player "Kil" (id=${K}) into Head`)).toBeNull();
    expect(parseDeath(`10:00:00 | Player "Vic" (DEAD) (id=${V} pos=<1.0, 2.0, 3.0>) is unconscious`)).toBeNull();
  });
  it("⚠️ a gamertag that says 'killed by Player' does not forge a killer", () => {
    expect(parseDeath(`10:00:00 | Player "x\" killed by Player \"y" (DEAD) (id=${V}) bled out`)).toMatchObject({ kind: "died", cause: "bled_out" });
    expect(parseDeath(`10:00:00 | Player "Vic (DEAD) (id=${K}) killed by Player" (DEAD) (id=${V}) drowned`)).toMatchObject({ kind: "died", victimDayzId: V });
  });
  it("a kill line keeps both positions", () => {
    const d = parseDeath(`10:00:00 | Player "Vic" (DEAD) (id=${V} pos=<101.0, 95.0, 998.6>) killed by Player "Kil" (id=${K} pos=<99.0, 93.0, 998.6>) with M4-A1 from 2.1 meters`)!;
    expect(d).toMatchObject({ kind: "killed", victimPos: { x: 101, y: 998.6, z: 95 }, killerPos: { x: 99, y: 998.6, z: 93 } });
  });
  it("a mutual kill (killer also DEAD) keeps the killer's position", () => {
    const d = parseDeath(`10:00:00 | Player "Vic" (DEAD) (id=${V} pos=<1.0, 2.0, 3.0>) killed by Player "Kil" (DEAD) (id=${K} pos=<4.0, 5.0, 6.0>) with SCR 17`)!;
    expect(d).toMatchObject({ kind: "killed", killerPos: { x: 4, y: 6, z: 5 } });
  });
});
