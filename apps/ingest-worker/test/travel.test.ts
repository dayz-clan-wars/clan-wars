import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { FAST_TRAVEL_POINTS } from "@factions/domain";
import { generateTravel, loadTravelTemplate, travelTemplateFor, POLE_BOX } from "../src/travel.js";

const asset = (mission: string) => JSON.parse(readFileSync(new URL(`../assets/travel/${mission}.json`, import.meta.url), "utf8"));
const RAW = asset("dayzOffline.nasdara");

describe("the fast-travel projection", () => {
  const template = loadTravelTemplate(RAW);

  it("keeps the template's 519 sheds and the Hub's arrival spots", () => {
    expect(template.PRABoxes).toHaveLength(519);
    expect(template.areaName).toBe("TeleportToHub");
    const out = JSON.parse(generateTravel(template, []));
    expect(out.PRABoxes).toHaveLength(519);
    expect(out.safePositions3D).toEqual(RAW.safePositions3D);
    expect(out.PRABoxes[0]).toEqual(RAW.PRABoxes[0]);
  });

  it("appends one wider box per pole, after the fixed points, in the order given", () => {
    const out = JSON.parse(generateTravel(template, [{ tag: "BEAR", x: 5551.69, y: 311.63, z: 8790.97 }, { tag: "COK", x: 1, y: 2, z: 3 }]));
    expect(out.PRABoxes).toHaveLength(521);
    expect(out.PRABoxes[519]).toEqual([POLE_BOX, [0, 0, 0], [5551.69, 311.63, 8790.97]]);
    expect(out.PRABoxes[520]).toEqual([POLE_BOX, [0, 0, 0], [1, 2, 3]]);
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

describe("the template for a server's map", () => {
  const templates = {
    "dayzOffline.nasdara": loadTravelTemplate(RAW),
  };
  const dir = (mission: string) => `/games/ni11558038_4/ftproot/dayzxb_missions/${mission}/custom`;

  it("picks Nasdara's 519 sheds for the Nasdara mission", () => {
    expect(travelTemplateFor(templates, dir("dayzOffline.nasdara")).PRABoxes).toHaveLength(519);
  });

  it("⚠️ refuses a map it has no template for, rather than sending another map's points", () => {
    expect(() => travelTemplateFor(templates, dir("dayzOffline.chernarusplus"))).toThrow(/none for mission dayzOffline\.chernarusplus/);
  });

  it("refuses a directory that is not a mission's custom folder", () => {
    expect(() => travelTemplateFor(templates, "/games/ni1/ftproot/dayzxb_missions/dayzOffline.nasdara")).toThrow(/cannot read the mission/);
  });
});


// ⚠️ Two statements of one fact: the website's travel layer (domain's
// fast-travel-points.json) and the file this worker uploads. A shed list
// changed in one and not the other draws doors that don't work, or hides
// ones that do. Clan poles are never in the layer: they live only in the
// generated upload, and the layer is built from the template alone.
describe("the website's travel layer", () => {
  it("is exactly the template's sheds, and nothing else", () => {
    const fromTemplate = RAW.PRABoxes.map((b: number[][]) => `${b[2]![0]!.toFixed(1)}:${b[2]![2]!.toFixed(1)}`).sort();
    const onTheMap = FAST_TRAVEL_POINTS.map((p) => `${p.x.toFixed(1)}:${p.z.toFixed(1)}`).sort();
    expect(onTheMap).toEqual(fromTemplate);
  });
});
