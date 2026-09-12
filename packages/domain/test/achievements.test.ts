import { describe, it, expect } from "vitest";
import { ACHIEVEMENTS, ACHIEVEMENT_BY_KEY, ACHIEVEMENT_GROUPS } from "../src/achievements";

describe("the achievement definitions", () => {
  it("are exactly fifty, keyed uniquely in snake_case", () => {
    expect(ACHIEVEMENTS).toHaveLength(50);
    const keys = ACHIEVEMENTS.map((a) => a.key);
    expect(new Set(keys).size).toBe(50);
    for (const k of keys) expect(k).toMatch(/^[a-z][a-z0-9_]*$/u);
    expect(Object.keys(ACHIEVEMENT_BY_KEY).sort()).toEqual([...keys].sort());
  });

  it("split 11 solo, 12 pve, 15 pvp, 12 team; team is clan-owned and nothing else is", () => {
    const by = (g: string) => ACHIEVEMENTS.filter((a) => a.group === g);
    expect([by("solo").length, by("pve").length, by("pvp").length, by("team").length]).toEqual([11, 12, 15, 12]);
    for (const a of ACHIEVEMENTS) expect(a.owner).toBe(a.group === "team" ? "clan" : "player");
    expect(ACHIEVEMENT_GROUPS).toEqual(["solo", "pve", "pvp", "team"]);
  });

  it("carry a positive integer target and a description a player can act on", () => {
    for (const a of ACHIEVEMENTS) {
      expect(Number.isInteger(a.target) && a.target >= 1).toBe(true);
      expect(a.name.length).toBeGreaterThan(2);
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
});
