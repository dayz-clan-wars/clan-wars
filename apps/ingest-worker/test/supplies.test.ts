import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { loadTemplate, generateSupplies } from "../src/supplies.js";

const RAW = JSON.parse(readFileSync(new URL("../assets/flag-supplies.template.json", import.meta.url), "utf8"));

const COK = { tag: "COK", texture: "Flag_Rooster", x: 5551.69, y: 311.63, z: 8790.97 };

describe("loadTemplate", () => {
  it("drops the anchor and keeps every other object", () => {
    // The real template: 73 objects, exactly one TerritoryFlag.
    expect(RAW.Objects).toHaveLength(73);
    expect(loadTemplate(RAW)).toHaveLength(72);
    expect(loadTemplate(RAW).some((o) => o.name === "TerritoryFlag")).toBe(false);
  });

  it("expresses positions as offsets from the anchor", () => {
    // Anchor is at 5572.65625 / 310.8094482421875 / 8811.84375. The
    // Flag_White sits at 5573.5546875 / 312.02886962890627 / 8811.8125.
    const flag = loadTemplate(RAW).find((o) => o.name === "Flag_White")!;
    expect(flag.pos[0]).toBeCloseTo(0.8984375, 6);
    expect(flag.pos[1]).toBeCloseTo(1.2194213867, 6);
    expect(flag.pos[2]).toBeCloseTo(-0.03125, 6);
  });

  it("throws when the anchor is missing", () => {
    // ⚠️ Without this, every faction's kit lands at absolute template
    // coordinates — one pile on the map, nowhere near any pole.
    expect(() => loadTemplate({ Objects: [{ name: "NailBox", pos: [1, 2, 3], ypr: [0, 0, 0], scale: 1, enableCEPersistency: 0, customString: "" }] }))
      .toThrow(/anchor/i);
  });

  it("throws when the template has two anchors", () => {
    const two = { Objects: [RAW.Objects.find((o: any) => o.name === "TerritoryFlag"), RAW.Objects.find((o: any) => o.name === "TerritoryFlag")] };
    expect(() => loadTemplate(two)).toThrow(/anchor/i);
  });
});

describe("generateSupplies", () => {
  const offsets = loadTemplate(RAW);

  it("places the kit at the faction's pole", () => {
    const out = JSON.parse(generateSupplies(offsets, [COK]));
    expect(out.Objects).toHaveLength(72);
    const flag = out.Objects.find((o: any) => o.name === "Flag_Rooster");
    expect(flag.pos[0]).toBeCloseTo(5551.69 + 0.8984375, 6);
    expect(flag.pos[2]).toBeCloseTo(8790.97 - 0.03125, 6);
  });

  it("substitutes the faction's texture for the white flag", () => {
    const out = JSON.parse(generateSupplies(offsets, [COK]));
    expect(out.Objects.some((o: any) => o.name === "Flag_White")).toBe(false);
    expect(out.Objects.filter((o: any) => o.name === "Flag_Rooster")).toHaveLength(1);
  });

  it("stamps every object with the owning faction's tag", () => {
    const out = JSON.parse(generateSupplies(offsets, [COK]));
    expect(out.Objects.every((o: any) => o.customString === "COK")).toBe(true);
  });

  it("keeps ypr, scale and persistency from the template", () => {
    // ⚠️ enableCEPersistency stays 0: the spawner rebuilds the kit at every
    // mission start, so nothing accumulates. Flipping it to 1 would make each
    // restart add a second kit on top of the first.
    const out = JSON.parse(generateSupplies(offsets, [COK]));
    expect(out.Objects.every((o: any) => o.enableCEPersistency === 0)).toBe(true);
    const src = RAW.Objects.find((o: any) => o.name === "Pickaxe");
    const got = out.Objects.find((o: any) => o.name === "Pickaxe");
    expect(got.ypr).toEqual(src.ypr);
    expect(got.scale).toBe(src.scale);
  });

  it("emits every faction's kit", () => {
    const other = { tag: "WLF", texture: "Flag_Wolf", x: 100, y: 200, z: 300 };
    const out = JSON.parse(generateSupplies(offsets, [COK, other]));
    expect(out.Objects).toHaveLength(144);
    expect(out.Objects.filter((o: any) => o.customString === "WLF")).toHaveLength(72);
  });

  it("produces a valid empty file for no factions", () => {
    // The last faction disbanding must yield {"Objects":[]}, not a crash and
    // not a stale file — otherwise their kit respawns forever.
    expect(JSON.parse(generateSupplies(offsets, []))).toEqual({ Objects: [] });
  });

  it("is byte-stable for the same input", () => {
    // A golden hash, not a self-comparison: the upload tick hashes these
    // exact bytes and only re-uploads when the hash changes, so this must
    // catch a changed key order, a changed float format or a dropped field
    // — not just "the function agrees with itself in one process".
    const out = generateSupplies(offsets, [COK]);
    const digest = createHash("sha256").update(out).digest("hex");
    expect(digest).toBe("497b9b852cddc4f949afe55c3e278c1214246a84b6c0d3e28a0dd401538b08b1");
  });

  it("emits exactly the six spawner fields per object, no more and no fewer", () => {
    // Adding a field to SpawnObject and forgetting to add it to the hand-
    // rolled serializer would silently drop it from the uploaded file —
    // valid JSON, semantically wrong. Guard the field set explicitly.
    const out = JSON.parse(generateSupplies(offsets, [COK]));
    const expectedKeys = ["name", "pos", "ypr", "scale", "enableCEPersistency", "customString"].sort();
    for (const obj of out.Objects) {
      expect(Object.keys(obj).sort()).toEqual(expectedKeys);
    }
  });
});
