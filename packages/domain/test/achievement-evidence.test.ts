import { describe, it, expect } from "vitest";
import {
  isKnife, isFist, isSledgehammer, meleeWeaponOf, isDogLabel, isMotorbikeClass, motorbikeOfWeapon,
  GRENADE_ENTITY_RE, MINE_ENTITIES, THROWN_MEAT_RE, TENTS, EMOTES, RUIN_RUBBLE_RE, RUIN_KIND,
} from "../src/achievement-evidence";
import { EMOTE_DICTIONARY } from "../src/emotes";

describe("melee", () => {
  it("knives", () => {
    for (const w of ["Hunting Knife", "Kukri", "Combat Knife", "Kitchen Knife", "Steak Knife"]) expect(isKnife(w)).toBe(true);
    for (const w of ["Sledgehammer", "Machete", "KA-M", "(MeleeFist)", null, ""]) expect(isKnife(w)).toBe(false);
  });
  it("fists in all three spellings", () => {
    for (const w of ["(MeleeFist)", "(MeleeFist_Heavy)", "(MeleeFistHeavy)"]) expect(isFist(w)).toBe(true);
    for (const w of ["MeleeFist", "Brass Knuckles", null]) expect(isFist(w)).toBe(false);
  });
  it("sledgehammer", () => {
    expect(isSledgehammer("Sledgehammer")).toBe(true);
    expect(isSledgehammer("Hatchet")).toBe(false);
  });
  it("meleeWeaponOf: a stable name, null for any gun", () => {
    expect(meleeWeaponOf("KA-M")).toBeNull();
    expect(meleeWeaponOf("DMR")).toBeNull();
    expect(meleeWeaponOf("TransportHit (Motorbike_02_Red)")).toBeNull();
    expect(meleeWeaponOf(null)).toBeNull();
    expect(meleeWeaponOf(" ")).toBeNull();
    expect(meleeWeaponOf("(MeleeFist)")).toBe(meleeWeaponOf("(MeleeFist_Heavy)"));
    expect(meleeWeaponOf("(MeleeFistHeavy)")).toBe(meleeWeaponOf("(MeleeFist)"));
    expect(meleeWeaponOf(" Hunting Knife ")).toBe("Hunting Knife");
    expect(meleeWeaponOf("Sledgehammer")).toBe("Sledgehammer");
  });
});

describe("dogs and motorbikes", () => {
  it("dog labels", () => {
    expect(isDogLabel("Doberman")).toBe(true);
    expect(isDogLabel("German Shepherd")).toBe(true);
    expect(isDogLabel("Animal_CanisFamiliaris_Grey")).toBe(true);
    expect(isDogLabel("Animal_CanisLupus_Grey")).toBe(false);
    expect(isDogLabel(null)).toBe(false);
  });
  it("motorbikes", () => {
    expect(isMotorbikeClass("Motorbike_02_Yellow")).toBe(true);
    expect(isMotorbikeClass("Offroad_02")).toBe(false);
    expect(motorbikeOfWeapon("TransportHit (Motorbike_02_Red)")).toBe("Motorbike_02_Red");
    expect(motorbikeOfWeapon("TransportHit (Offroad_02)")).toBeNull();
    expect(motorbikeOfWeapon(null)).toBeNull();
  });
});

describe("traps, grenades, meat", () => {
  it("grenade entities as death.ts stores them", () => {
    for (const e of ["6", "EGD", "RGD", "M67Grenade", "MNGrenade"]) expect(GRENADE_ENTITY_RE.test(e)).toBe(true);
    for (const e of ["LandMineTrap", "Claymore", "Plastic", "60", "Animal_UrsusArctos", "Truck_01_Covered"]) expect(GRENADE_ENTITY_RE.test(e)).toBe(false);
  });
  it("mines", () => expect(MINE_ENTITIES).toEqual(["LandMineTrap", "Claymore"]));
  it("thrown meat", () => {
    expect(THROWN_MEAT_RE.test("ChickenBreastMeat")).toBe(true);
    expect(THROWN_MEAT_RE.test("HumanSteakMeat")).toBe(true);
    expect(THROWN_MEAT_RE.test("Meatball Can")).toBe(false);
  });
});

describe("camp and emotes", () => {
  it("tents include every packed name seen in production", () => {
    for (const t of ["Large Tent", "Car Tent", "Medium Tent", "Canopy Tent", "Improvised Shelter", "Tarp Shelter", "Party Tent"]) expect(TENTS).toContain(t);
  });
  it("the 36 emotes, in payload form (with the Emote prefix), no duplicates", () => {
    expect(EMOTES).toHaveLength(36);
    expect(new Set(EMOTES).size).toBe(36);
    expect(EMOTES.every((e) => /^Emote[A-Za-z0-9]+$/.test(e))).toBe(true);
    for (const e of ["EmoteSitA", "EmoteRPSRandom", "EmoteSOS", "EmoteGetDown", "EmoteHold"]) expect(EMOTES).toContain(e);
  });
  it("every emote the /link dictionary knows is in the list", () => {
    for (const d of EMOTE_DICTIONARY) expect(EMOTES).toContain(d.token);
  });
});

describe("ruins", () => {
  it.each([
    ["door1_metal", "door"], ["door3_barricade", "door"], ["window4_metal", "window"], ["window2_wood", "window"],
    ["wall1_wood", "wall"], ["wall2_window_wood", "wall"], ["wall3_door_wood", "wall"], ["roof1", "roof"],
    ["rubble_rubble1", "rubble"], ["ladder_rebuild", "ladder"],
  ])("%s → %s", (p, k) => expect(RUIN_KIND(p)).toBe(k));
  it("anything else is null", () => {
    for (const p of ["doorframe", "base", "roofing", "Fence", ""]) expect(RUIN_KIND(p)).toBeNull();
  });
  it("rubble", () => {
    expect(RUIN_RUBBLE_RE.test("rubble_rubble1")).toBe(true);
    expect(RUIN_RUBBLE_RE.test("door1_metal")).toBe(false);
  });
});
