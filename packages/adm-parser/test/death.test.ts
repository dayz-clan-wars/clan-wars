import { describe, it, expect } from "vitest";
import { parseDeath } from "../src/death.js";
const V = "A".repeat(40), K = "B".repeat(40);
describe("parseDeath", () => {
  it("reads a PvP kill with weapon and distance, both ids anchored", () => {
    expect(parseDeath(`10:00:00 | Player "Vic" (DEAD) (id=${V} pos=<1.0, 2.0, 3.0>) killed by Player "Kil" (id=${K} pos=<4.0, 5.0, 6.0>) with M4A1 from 153.4 meters`))
      .toEqual({ kind: "killed", victimDayzId: V, victimGamertag: "Vic", killerDayzId: K, killerGamertag: "Kil", weapon: "M4A1", distanceM: 153.4 });
  });
  it("reads a PvP kill without distance (melee)", () => {
    expect(parseDeath(`10:00:00 | Player "Vic" (DEAD) (id=${V}) killed by Player "Kil" (id=${K}) with Knife`)).toMatchObject({ kind: "killed", weapon: "Knife", distanceM: null });
  });
  it.each([
    [`killed by Zmb_Male_Farmer`, "infected", "Zmb_Male_Farmer"], [`killed by Animal_UrsusArctos`, "animal", "Animal_UrsusArctos"],
    [`killed by FallDamage`, "fall", "FallDamage"], [`killed by CivilianSedan`, "vehicle", "CivilianSedan"],
    [`killed by SomethingNew`, "environment", "SomethingNew"], [`bled out`, "bled_out", null], [`drowned`, "drowned", null],
    [`committed suicide`, "suicide", null], [`died.`, "died", null],
  ])("classifies '%s' as %s", (tail, cause, entity) => {
    expect(parseDeath(`10:00:00 | Player "Vic" (DEAD) (id=${V} pos=<1.0, 2.0, 3.0>) ${tail}`)).toEqual({ kind: "died", victimDayzId: V, victimGamertag: "Vic", cause, entity });
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
});
