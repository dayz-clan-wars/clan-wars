import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { generateTravel, loadTravelTemplate, POLE_BOX } from "../src/travel.js";

const RAW = JSON.parse(readFileSync(new URL("../assets/teleport-hub.template.json", import.meta.url), "utf8"));

describe("the fast-travel projection", () => {
  const template = loadTravelTemplate(RAW);

  it("keeps the template's 209 points and the Hub's arrival spots", () => {
    expect(template.PRABoxes).toHaveLength(209);
    expect(template.areaName).toBe("TeleportToHub");
    const out = JSON.parse(generateTravel(template, []));
    expect(out.PRABoxes).toHaveLength(209);
    expect(out.safePositions3D).toEqual(RAW.safePositions3D);
    expect(out.PRABoxes[0]).toEqual(RAW.PRABoxes[0]);
  });

  it("appends one wider box per pole, after the fixed points, in the order given", () => {
    const out = JSON.parse(generateTravel(template, [{ tag: "BEAR", x: 5551.69, y: 311.63, z: 8790.97 }, { tag: "COK", x: 1, y: 2, z: 3 }]));
    expect(out.PRABoxes).toHaveLength(211);
    expect(out.PRABoxes[209]).toEqual([POLE_BOX, [0, 0, 0], [5551.69, 311.63, 8790.97]]);
    expect(out.PRABoxes[210]).toEqual([POLE_BOX, [0, 0, 0], [1, 2, 3]]);
  });

  it("is byte-stable for the same input", () => {
    const poles = [{ tag: "COK", x: 1, y: 2, z: 3 }];
    expect(generateTravel(template, poles)).toBe(generateTravel(template, poles));
  });

  it("refuses a template with no points", () => {
    expect(() => loadTravelTemplate({ areaName: "x", PRABoxes: [], safePositions3D: [] })).toThrow(/no PRABoxes/);
    expect(() => loadTravelTemplate({})).toThrow(/expected/);
  });
});
