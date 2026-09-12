import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
const app = join(import.meta.dirname, "..", "app");
const read = (...p: string[]) => readFileSync(join(app, ...p), "utf8");

describe("achievement surfaces", () => {
  it("the player profile renders the wall, after Raiding", () => {
    const src = read("(site)", "players", "[gamertag]", "page.tsx");
    expect(src).toContain("achievementsFor(");
    expect(src).toMatch(/<AchievementWall\b/u);
    expect(src.indexOf('title="Raiding"')).toBeLessThan(src.indexOf("<AchievementWall"));
    expect(src).toMatch(/achievementsFor\([^)]*\)\.catch\(/u);   // never a reason to fail the page
  });
  it("the owner's panels carry the closest-to-unlocking strip", () => {
    expect(read("components", "owner.tsx")).toMatch(/<ClosestPanel\b/u);
  });
  it.each([join("(site)", "clans", "[tag]", "page.tsx"), join("(site)", "clan", "page.tsx")])("%s renders the team wall", (rel) => {
    const src = readFileSync(join(app, rel), "utf8");
    expect(src).toContain("achievementsFor({ clanTag");
    expect(src).toMatch(/<AchievementWall\b/u);
  });
  it("no tile copy or component mentions a coordinate field", () => {
    for (const f of [read("components", "achievement-wall.tsx"), readFileSync(join(import.meta.dirname, "..", "lib", "achievements-copy.ts"), "utf8")]) {
      expect(f).not.toMatch(/\b(x|z|poleKey)\b\s*[:=]/u);
    }
  });
});
