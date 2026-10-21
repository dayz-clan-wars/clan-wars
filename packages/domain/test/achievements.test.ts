import { describe, it, expect } from "vitest";
import { ACHIEVEMENTS, ACHIEVEMENT_BY_KEY, ACHIEVEMENT_GROUPS, EARNABLE_ACHIEVEMENTS, isRetired } from "../src/achievements";
import { FIREARMS, FIREARM_CLASSES } from "../src/firearms";
import { EMOTES } from "../src/achievement-evidence";

describe("the achievement definitions", () => {
  it("are exactly 149, keyed uniquely in snake_case", () => {
    expect(ACHIEVEMENTS).toHaveLength(149);
    const keys = ACHIEVEMENTS.map((a) => a.key);
    expect(new Set(keys).size).toBe(149);
    for (const k of keys) expect(k).toMatch(/^[a-z][a-z0-9_]*$/u);
    expect(Object.keys(ACHIEVEMENT_BY_KEY).sort()).toEqual([...keys].sort());
  });

  it("146 can be earned: Wanderer, Wolf Bait and Bear Necessities are retired, but stay defined for their holders", () => {
    expect(EARNABLE_ACHIEVEMENTS).toHaveLength(146);
    for (const k of ["wanderer", "wolf_bait", "bear_necessities"]) expect(EARNABLE_ACHIEVEMENTS.map((a) => a.key)).not.toContain(k);
    expect(ACHIEVEMENTS.filter(isRetired).map((a) => a.key)).toEqual(["wanderer", "wolf_bait", "bear_necessities"]);
    expect(ACHIEVEMENT_BY_KEY.wanderer.name).toBe("Wanderer");
    expect([ACHIEVEMENT_BY_KEY.wolf_bait.name, ACHIEVEMENT_BY_KEY.bear_necessities.name]).toEqual(["Wolf Bait", "Bear Necessities"]);
  });

  it("split 18 solo, 36 pve, 83 pvp, 12 team; team is clan-owned and nothing else is", () => {
    const by = (g: string) => ACHIEVEMENTS.filter((a) => a.group === g);
    expect([by("solo").length, by("pve").length, by("pvp").length, by("team").length]).toEqual([18, 36, 83, 12]);
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
    expect(ACHIEVEMENTS.filter((a) => !("section" in a))).toHaveLength(90);
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

  it("ruins, traps and explosives, camp: the thirteen tiles as agreed", () => {
    const row = (k: string) => { const a = ACHIEVEMENT_BY_KEY[k as keyof typeof ACHIEVEMENT_BY_KEY]; return [a.key, a.name, a.description, a.group, a.target]; };
    expect(["squatter", "rubble_rouser", "renovator", "fixer_upper", "snapped", "tripped", "snagged", "minesweeper", "frag_out", "barrel_hoarder", "pack_up", "sea_legs", "minefield"].map(row)).toEqual([
      ["squatter", "Squatter", "Repair a ruined building", "pve", 1],
      ["rubble_rouser", "Rubble Rouser", "Clear 10 rubble piles", "pve", 10],
      ["renovator", "Renovator", "Make 25 ruin repairs", "pve", 25],
      ["fixer_upper", "Fixer-Upper", "Repair a door, a window and a roof", "pve", 1],
      ["snapped", "Snapped", "Step in a bear trap", "pve", 1],
      ["tripped", "Tripped", "Set off a tripwire", "pve", 1],
      ["snagged", "Snagged", "Get caught in barbed wire", "pve", 1],
      ["minesweeper", "Minesweeper", "Get killed by a mine or claymore", "pve", 1],
      ["frag_out", "Frag Out", "Get killed by a grenade", "pve", 1],
      ["barrel_hoarder", "Hoarder", "Place 10 barrels", "pve", 10],
      ["pack_up", "Pack Up", "Pack 10 tents", "pve", 10],
      ["sea_legs", "Sea Legs", "Place a sea chest", "pve", 1],
      ["minefield", "Minefield", "Place a land mine", "pve", 1],
    ]);
  });

  it("emotes, oddities and milestones: the sixteen tiles as agreed", () => {
    const row = (k: string) => { const a = ACHIEVEMENT_BY_KEY[k as keyof typeof ACHIEVEMENT_BY_KEY]; return [a.key, a.name, a.description, a.group, a.target, a.unit]; };
    expect(["mime", "full_repertoire", "rps_champ", "performer", "burned", "hipster", "comeback", "sleeps_with_fishes", "warlord", "long_shot", "headhunter", "lifer", "devoted", "globetrotter", "master_builder", "hundred_lives"].map(row)).toEqual([
      ["mime", "Mime", "Perform 10 different emotes", "solo", 10, "count"],
      ["full_repertoire", "Full Repertoire", "Perform every emote", "solo", EMOTES.length, "count"],
      ["rps_champ", "Best of Ten", "Play rock-paper-scissors 10 times", "solo", 10, "count"],
      ["performer", "Performer", "Perform 500 emotes", "solo", 500, "count"],
      ["burned", "Burned", "Get burned by a fire", "pve", 1, "count"],
      ["hipster", "Hipster", "Eat your food before it was cool", "pve", 1, "count"],
      ["comeback", "Comeback", "Come round after being knocked out 10 times", "pve", 10, "count"],
      ["sleeps_with_fishes", "Sleeps With the Fishes", "Drown", "pve", 1, "count"],
      ["warlord", "Warlord", "Get 250 PvP kills", "pvp", 250, "count"],
      ["long_shot", "Long Shot", "A kill from 500 m or more", "pvp", 500, "m"],
      ["headhunter", "Headhunter", "Kill 25 different players", "pvp", 25, "count"],
      ["lifer", "Lifer", "Play for 500 hours", "solo", 500, "hours"],
      ["devoted", "Devoted", "Play on 30 consecutive days", "solo", 30, "days"],
      ["globetrotter", "Globetrotter", "Seen in 150 different 1 km grid squares", "solo", 150, "count"],
      ["master_builder", "Master Builder", "Earn 2,000 build points", "pve", 2000, "count"],
      ["hundred_lives", "Hundred Lives", "Die 100 times, any cause", "pve", 100, "count"],
    ]);
    // Full Repertoire's target is the list's length, never a typed 36: an emote added there moves it.
    expect(ACHIEVEMENT_BY_KEY.full_repertoire.target).toBe(36);
    expect(ACHIEVEMENTS.map((a) => a.key)).not.toContain("tenderized");
  });
});
