import { describe, it, expect } from "vitest";
import { readFileSync, existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { ACHIEVEMENT_KEYS } from "@factions/domain";
import { shareCardLine, shareCardParams } from "../lib/achievement-share";

const web = join(import.meta.dirname, "..");
const route = join(web, "app", "api", "og", "achievement", "[key]", "route.tsx");

describe("the share card's owner line", () => {
  const q = (s: string) => shareCardParams(new URLSearchParams(s));
  it("is gamertag · [TAG] · earned d MMM, each part optional", () => {
    expect(shareCardLine(q("gamertag=DeadeyeDan&tag=wlf&earned=2026-09-12T10:00:00Z"))).toBe("DeadeyeDan · [WLF] · earned 12 Sept");
    expect(shareCardLine(q("gamertag=DeadeyeDan"))).toBe("DeadeyeDan");
    expect(shareCardLine(q("earned=2026-09-12"))).toBe("earned 12 Sept");
    expect(shareCardLine(q(""))).toBe("");
  });
  it("clips and cleans what it is handed — the line is drawn at a fixed width", () => {
    expect(q(`gamertag=${"x".repeat(40)}`).gamertag).toHaveLength(24);
    expect(q("tag=toolong").tag).toBe("TOOLO");
    expect(q("gamertag=a%0Ab%09c").gamertag).toBe("abc");
    expect(q("earned=yesterday").earned).toBeNull();
    expect(q("gamertag=%20%20").gamertag).toBeNull();
  });
});

describe("the share card route", () => {
  const src = readFileSync(route, "utf8");
  it("is a 1200×630 next/og image, public, that 404s an unknown key", () => {
    expect(src).toMatch(/from "next\/og"/u);
    expect(src).toContain("width: 1200");
    expect(src).toContain("height: 630");
    expect(src).toMatch(/status: 404/u);
  });
  it("reads its font and mark from public/, which the Dockerfile ships", () => {
    expect(src).toMatch(/join\(process\.cwd\(\), "public"/u);
    expect(existsSync(join(web, "public", "fonts", "ArchivoBlack.ttf"))).toBe(true);
    expect(existsSync(join(web, "public", "mark.png"))).toBe(true);
  });
  it("draws the badge inline and never a coordinate", () => {
    expect(src).toMatch(/<AchievementBadge\b/u);
    expect(src).not.toMatch(/\b(x|z|poleKey)\b\s*[:=]/u);
  });
});

describe("the badge art the bot's embeds and the share card point at", () => {
  // ⚠️ Two statements of one fact: the keys in @factions/domain and the PNGs in
  // public/achievements/. Drift is a card in Discord with no badge, not an error.
  it.each(["unlocked", "locked"])("has a %s PNG for every key, and no PNG for a key that is not defined", (state) => {
    const dir = join(web, "public", "achievements", state);
    expect(readdirSync(dir).filter((f) => f.endsWith(".png")).map((f) => f.replace(/\.png$/u, "")).sort()).toEqual([...ACHIEVEMENT_KEYS].sort());
  });
});
