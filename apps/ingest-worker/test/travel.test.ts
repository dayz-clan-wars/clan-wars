import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { FAST_TRAVEL_POINTS, WORLD_MAP } from "@factions/domain";
import { generateTravel, loadTravelTemplate, travelTemplateFor, POLE_BOX } from "../src/travel.js";

const asset = (mission: string) => JSON.parse(readFileSync(new URL(`../assets/travel/${mission}.json`, import.meta.url), "utf8"));
const RAW = asset("dayzOffline.enoch");

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

describe("the template for a server's map", () => {
  const templates = {
    "dayzOffline.chernarusplus": loadTravelTemplate(asset("dayzOffline.chernarusplus")),
    "dayzOffline.enoch": loadTravelTemplate(RAW),
  };
  const dir = (mission: string) => `/games/ni11558038_4/ftproot/dayzxb_missions/${mission}/custom`;

  it("picks Chernarus's 518 points for the Chernarus mission, and Livonia's 209 for Livonia", () => {
    expect(travelTemplateFor(templates, dir("dayzOffline.chernarusplus")).PRABoxes).toHaveLength(518);
    expect(travelTemplateFor(templates, dir("dayzOffline.enoch")).PRABoxes).toHaveLength(209);
  });

  it("⚠️ refuses a map it has no template for, rather than sending another map's points", () => {
    expect(() => travelTemplateFor(templates, dir("dayzOffline.sakhal"))).toThrow(/none for mission dayzOffline\.sakhal/);
  });

  it("refuses a directory that is not a mission's custom folder", () => {
    expect(() => travelTemplateFor(templates, "/games/ni1/ftproot/dayzxb_missions/dayzOffline.enoch")).toThrow(/cannot read the mission/);
  });
});

describe("the web map's travel points", () => {
  it("⚠️ are the uploaded template's points for the map this deployment runs", () => {
    // Two statements of one fact: packages/domain/src/fast-travel-points.json
    // draws the map layer, this template is what the server actually reads.
    const t = loadTravelTemplate(asset(`dayzOffline.${WORLD_MAP}`));
    expect(FAST_TRAVEL_POINTS).toEqual(t.PRABoxes.map((b) => ({ x: Math.round(b[2][0] * 10) / 10, z: Math.round(b[2][2] * 10) / 10 })));
  });
});

