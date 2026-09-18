import { describe, it, expect } from "vitest";
import { CLAIMABLE_FLAGS, FLAG_COLORS, NEUTRAL_FLAG, flagColor } from "../src/flags";

/** Discord's two message backgrounds, which every clan colour must be legible on. */
const DARK = "#313338";
const LIGHT = "#FFFFFF";

function channel(c: number): number {
  const v = c / 255;
  return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
}
function luminance(hex: string): number {
  const n = Number.parseInt(hex.slice(1), 16);
  const [r, g, b] = [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  return 0.2126 * channel(r!) + 0.7152 * channel(g!) + 0.0722 * channel(b!);
}
function contrast(a: string, b: string): number {
  const [x, y] = [luminance(a), luminance(b)];
  return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
}

describe("clan role colours", () => {
  it("covers every claimable flag and nothing else", () => {
    expect(Object.keys(FLAG_COLORS).sort()).toEqual([...CLAIMABLE_FLAGS].sort());
  });

  it("⚠️ never repeats a colour — two clans wearing one would be indistinguishable", () => {
    const values = Object.values(FLAG_COLORS);
    expect(new Set(values).size).toBe(values.length);
  });

  it("is written in the #RRGGBB form the contrast check and Discord both assume", () => {
    for (const [flag, hex] of Object.entries(FLAG_COLORS)) {
      expect(hex, flag).toMatch(/^#[0-9A-F]{6}$/u);
    }
  });

  it.each(Object.entries(FLAG_COLORS))("%s is legible on both Discord themes", (flag, hex) => {
    expect(contrast(hex, DARK), `${flag} on dark`).toBeGreaterThanOrEqual(3);
    expect(contrast(hex, LIGHT), `${flag} on light`).toBeGreaterThanOrEqual(3);
  });

  describe("flagColor", () => {
    it("gives Discord the integer form of the table's hex", () => {
      expect(flagColor("Flag_Rooster")).toBe(0xd17e3b);
      expect(flagColor("Flag_Zagorky")).toBe(0x69a300);
    });

    it("⚠️ is null for the neutral flag and anything unknown — leave the role alone, never blank it", () => {
      expect(flagColor(NEUTRAL_FLAG)).toBeNull();
      expect(flagColor("Flag_NotAThing")).toBeNull();
    });

    it("never returns 0, which Discord reads as 'default colour' rather than black", () => {
      for (const flag of CLAIMABLE_FLAGS) expect(flagColor(flag), flag).not.toBe(0);
    });
  });
});
