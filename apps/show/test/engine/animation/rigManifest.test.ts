import fs from "node:fs";
import { describe, it, expect } from "vitest";
import { BORIS_RIG, PAVEL_RIG, allVariantIds } from "../../../src/engine/animation/rigManifest.js";
import { ASSETS } from "../../../src/assets.js";

function idsPresent(svgFile: string, ids: string[]): string[] {
  const svg = fs.readFileSync(svgFile, "utf8");
  return ids.filter((id) => !new RegExp(`id="${id}"`).test(svg));
}

describe("rigManifest", () => {
  it("BORIS_RIG ids all exist in Boris.svg", () => {
    expect(idsPresent(ASSETS.rigs.boris, allVariantIds(BORIS_RIG))).toEqual([]);
  });

  it("PAVEL_RIG ids all exist in Pavel.svg", () => {
    expect(idsPresent(ASSETS.rigs.pavel, allVariantIds(PAVEL_RIG))).toEqual([]);
  });

  it("both rigs expose the Rhubarb rest mouth Lip_X", () => {
    expect(BORIS_RIG.mouths).toContain("Lip_X");
    expect(PAVEL_RIG.mouths).toContain("Lip_X");
  });

  it("both rigs expose pupils, consistent with eyes.open and present in the SVG", () => {
    expect(BORIS_RIG.pupils.every((id) => BORIS_RIG.eyes.open.includes(id))).toBe(true);
    expect(PAVEL_RIG.pupils.every((id) => PAVEL_RIG.eyes.open.includes(id))).toBe(true);
    expect(idsPresent(ASSETS.rigs.boris, BORIS_RIG.pupils)).toEqual([]);
    expect(idsPresent(ASSETS.rigs.pavel, PAVEL_RIG.pupils)).toEqual([]);
  });
});
