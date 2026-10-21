import { describe, it, expect } from "vitest";
import { ACHIEVEMENTS, ACHIEVEMENT_BY_KEY, ACHIEVEMENT_GROUPS, EARNABLE_ACHIEVEMENTS, isRetired } from "../src/achievements";
import { FIREARMS, FIREARM_CLASSES } from "../src/firearms";

describe("the achievement definitions", () => {
  it("are exactly 120, keyed uniquely in snake_case", () => {
    expect(ACHIEVEMENTS).toHaveLength(120);
    const keys = ACHIEVEMENTS.map((a) => a.key);
    expect(new Set(keys).size).toBe(120);
    for (const k of keys) expect(k).toMatch(/^[a-z][a-z0-9_]*$/u);
    expect(Object.keys(ACHIEVEMENT_BY_KEY).sort()).toEqual([...keys].sort());
  });

  it("117 can be earned: Wanderer, Wolf Bait and Bear Necessities are retired, but stay defined for their holders", () => {
    expect(EARNABLE_ACHIEVEMENTS).toHaveLength(117);
    for (const k of ["wanderer", "wolf_bait", "bear_necessities"]) expect(EARNABLE_ACHIEVEMENTS.map((a) => a.key)).not.toContain(k);
    expect(ACHIEVEMENTS.filter(isRetired).map((a) => a.key)).toEqual(["wanderer", "wolf_bait", "bear_necessities"]);
    expect(ACHIEVEMENT_BY_KEY.wanderer.name).toBe("Wanderer");
    expect([ACHIEVEMENT_BY_KEY.wolf_bait.name, ACHIEVEMENT_BY_KEY.bear_necessities.name]).toEqual(["Wolf Bait", "Bear Necessities"]);
  });

  it("split 11 solo, 17 pve, 80 pvp, 12 team; team is clan-owned and nothing else is", () => {
    const by = (g: string) => ACHIEVEMENTS.filter((a) => a.group === g);
    expect([by("solo").length, by("pve").length, by("pvp").length, by("team").length]).toEqual([11, 17, 80, 12]);
    for (const a of ACHIEVEMENTS) expect(a.owner).toBe(a.group === "team" ? "clan" : "player");
    expect(ACHIEVEMENT_GROUPS).toEqual(["solo", "pve", "pvp", "team"]);
  });

  it("carry a positive integer target and a description a player can act on", () => {
    for (const a of ACHIEVEMENTS) {
      expect(Number.isInteger(a.target) && a.target >= 1).toBe(true);
      // A gun tile is named for its gun, and the P1 is two letters long.
      expect(a.name.length).toBeGreaterThan("section" in a ? 1 : 2);
      expect(a.description).toMatch(/^[A-Z].*[^.]$/u);   // sentence case, no trailing full stop (tiles add none)
      expect(a.description.toLowerCase()).not.toContain("faction");
    }
  });

  it("states the thresholds the spec agreed", () => {
    const t = (k: string) => ACHIEVEMENT_BY_KEY[k as keyof typeof ACHIEVEMENT_BY_KEY].target;
    expect([t("marksman"), t("sniper"), t("point_blank")]).toEqual([150, 300, 5]);
    expect([t("long_haul"), t("veteran"), t("ironman")]).toEqual([24, 100, 5]);
    expect([t("loyalist"), t("regular")]).toEqual([30, 7]);
    expect([t("ten_down"), t("centurion"), t("warpath"), t("full_strength"), t("dynasty")]).toEqual([10, 100, 25, 10, 4]);
  });

  it("the armory: a tile per firearm in catalogue order, six class tiles, and Full Armory, all 59 marked for the armory section", () => {
    const armory = ACHIEVEMENTS.filter((a) => "section" in a && a.section === "armory");
    expect(armory).toHaveLength(59);
    for (const a of armory) expect(a).toMatchObject({ group: "pvp", owner: "player", unit: "count" });
    const guns = armory.filter((a) => a.key.startsWith("gun_"));
    expect(guns.map((a) => a.key)).toEqual(FIREARMS.map((f) => `gun_${f.key}`));
    FIREARMS.forEach((f, i) => expect(guns[i]).toMatchObject({ name: f.name, description: `A PvP kill with the ${f.name}`, target: 1 }));
    expect(ACHIEVEMENT_BY_KEY.gun_akm).toMatchObject({ name: "KA-M", description: "A PvP kill with the KA-M" });
    const classes = armory.filter((a) => a.key.startsWith("class_"));
    expect(classes.map((a) => [a.key, a.name, a.description, a.target])).toEqual([
      ["class_pistols", "Sidearms", "A PvP kill with every pistol", 12],
      ["class_smgs", "Spray and Pray", "A PvP kill with every SMG", 7],
      ["class_shotguns", "Buckshot", "A PvP kill with every shotgun", 5],
      ["class_assault_rifles", "Rifleman", "A PvP kill with every assault rifle", 13],
      ["class_rifles", "Hunter", "A PvP kill with every rifle", 11],
      ["class_snipers", "Overwatch", "A PvP kill with every sniper rifle", 2],
    ]);
    // One statement of a class's size: the target is the catalogue's count, never a typed number.
    FIREARM_CLASSES.forEach((c, i) => expect(classes[i]!.target).toBe(FIREARMS.filter((f) => f.class === c).length));
    expect(ACHIEVEMENT_BY_KEY.full_armory).toMatchObject({ name: "Full Armory", description: "A PvP kill with every firearm on Nasdara", target: 52 });
    expect(ACHIEVEMENTS.filter((a) => !("section" in a))).toHaveLength(61);
  });

  it("melee, dogs and motorbikes: the eleven tiles as agreed", () => {
    const row = (k: string) => { const a = ACHIEVEMENT_BY_KEY[k as keyof typeof ACHIEVEMENT_BY_KEY]; return [a.key, a.name, a.description, a.group, a.target]; };
    expect(["knife_work", "bare_knuckles", "sledge", "melee_mix", "dog_food", "bad_dog", "chew_toy", "road_rash", "wipeout", "hit_and_run", "roadkill"].map(row)).toEqual([
      ["knife_work", "Knife Work", "A PvP kill with a knife", "pvp", 1],
      ["bare_knuckles", "Bare Knuckles", "A PvP kill with your fists", "pvp", 1],
      ["sledge", "Sledge", "A PvP kill with a sledgehammer", "pvp", 1],
      ["melee_mix", "Hands On", "PvP kills with 5 different melee weapons", "pvp", 5],
      ["dog_food", "Dog Food", "Get killed by a dog", "pve", 1],
      ["bad_dog", "Bad Dog", "Survive a dog attack", "pve", 1],
      ["chew_toy", "Chew Toy", "Take 10 dog bites", "pve", 10],
      ["road_rash", "Road Rash", "Get hurt by a motorbike", "pve", 1],
      ["wipeout", "Wipeout", "Get killed by a motorbike", "pve", 1],
      ["hit_and_run", "Hit and Run", "Hit a player with a motorbike", "pvp", 1],
      ["roadkill", "Roadkill", "A PvP kill with a motorbike", "pvp", 1],
    ]);
  });
});
