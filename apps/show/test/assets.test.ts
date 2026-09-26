import { describe, it, expect } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import { ASSETS } from "../src/assets.js";

function everyPath(): string[] {
  return [
    ASSETS.rigs.background, ASSETS.rigs.boris, ASSETS.rigs.chairs, ASSETS.rigs.deskNoChair,
    ASSETS.rigs.desk, ASSETS.rigs.pavel,
    ASSETS.fonts.display, ASSETS.fonts.gamertag,
    ASSETS.introMp3, ASSETS.outroMp3, ASSETS.introScreen, ASSETS.outroScreen,
  ];
}

describe("ASSETS", () => {
  it("every asset path exists on disk", () => {
    for (const p of everyPath()) expect(existsSync(p), p).toBe(true);
  });

  it("intro-screen.png is 3840x2160 (spec §11.1, the new Clan Wars intro)", () => {
    const buf = readFileSync(ASSETS.introScreen);
    // IHDR: width at bytes 16-19, height at bytes 20-23, big-endian.
    const width = buf.readUInt32BE(16);
    const height = buf.readUInt32BE(20);
    expect(width).toBe(3840);
    expect(height).toBe(2160);
  });

  it("every rig SVG starts with <svg or <?xml", () => {
    const rigs = [
      ASSETS.rigs.background, ASSETS.rigs.boris, ASSETS.rigs.chairs,
      ASSETS.rigs.deskNoChair, ASSETS.rigs.desk, ASSETS.rigs.pavel,
    ];
    for (const p of rigs) {
      const head = readFileSync(p, "utf8").trimStart().slice(0, 5);
      expect(head.startsWith("<svg") || head.startsWith("<?xml"), p).toBe(true);
    }
  });
});
