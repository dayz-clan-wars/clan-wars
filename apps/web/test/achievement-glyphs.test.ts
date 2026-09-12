import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ACHIEVEMENT_KEYS } from "@factions/domain";
import { ACHIEVEMENT_GLYPHS } from "../lib/achievement-glyphs";
import { build, glyphOf } from "../scripts/build-achievement-glyphs";

/**
 * The glyph module is generated from public/achievements/svg/*.svg and
 * committed. Two-way, like apps/bot's rules.test.ts: a key with no glyph
 * would draw an empty shield, and a glyph with no key is a badge nothing can
 * show.
 */
describe("achievement glyphs", () => {
  it("has exactly one glyph per achievement key, and no glyph for a key that is not defined", () => {
    expect(Object.keys(ACHIEVEMENT_GLYPHS).sort()).toEqual([...ACHIEVEMENT_KEYS].sort());
  });
  it("every glyph is a non-empty path", () => {
    for (const [k, d] of Object.entries(ACHIEVEMENT_GLYPHS)) expect(d, k).toMatch(/^M[\d.\s-]/u);
  });
  it("⚠️ the committed module matches the SVGs — rerun `pnpm --filter @factions/web exec tsx scripts/build-achievement-glyphs.ts` after changing one", () => {
    expect(readFileSync(join(import.meta.dirname, "..", "lib", "achievement-glyphs.ts"), "utf8")).toBe(build());
  });
  it("reads the glyph, not the shield, out of an SVG", () => {
    const svg = '<svg><path d="M32 4l22 8v16z"></path><g transform="translate(17 15) scale(1.25)"><path d="M1 2h3" fill="none"></path></g></svg>';
    expect(glyphOf(svg, "x")).toBe("M1 2h3");
    expect(() => glyphOf("<svg></svg>", "x")).toThrow(/x\.svg/u);
  });
});
