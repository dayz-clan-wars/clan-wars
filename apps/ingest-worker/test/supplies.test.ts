import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { loadTemplate, generateSupplies } from "../src/supplies.js";

const RAW = JSON.parse(readFileSync(new URL("../assets/flag-supplies.template.json", import.meta.url), "utf8"));

const COK = { tag: "COK", texture: "Flag_Rooster", x: 5551.69, y: 311.63, z: 8790.97, supplied: true };

describe("loadTemplate", () => {
  it("drops the anchor and keeps every other object", () => {
    // The real template: 123 objects, exactly one TerritoryFlag.
    expect(RAW.Objects).toHaveLength(123);
    expect(loadTemplate(RAW)).toHaveLength(122);
    expect(loadTemplate(RAW).some((o) => o.name === "TerritoryFlag")).toBe(false);
  });

  it("expresses positions as offsets from the anchor", () => {
    // Anchor is at 4562.60302734375 / 338.8551330566406 / 10059.1298828125.
    // Both Flag_White sit at 4562.3193359375 / 340.1875305175781 / 10058.892578125.
    const flag = loadTemplate(RAW).find((o) => o.name === "Flag_White")!;
    expect(flag.pos[0]).toBeCloseTo(-0.28369140625, 6);
    expect(flag.pos[1]).toBeCloseTo(1.3323974609, 6);
    expect(flag.pos[2]).toBeCloseTo(-0.2373046875, 6);
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
    // Every template object but the anchor, once each.
    expect(out.Objects).toHaveLength(122);
    const flag = out.Objects.find((o: any) => o.name === "Flag_Rooster");
    expect(flag.pos[0]).toBeCloseTo(5551.69 - 0.28369140625, 6);
    expect(flag.pos[2]).toBeCloseTo(8790.97 - 0.2373046875, 6);
  });

  it("substitutes the faction's texture for the white flag", () => {
    const out = JSON.parse(generateSupplies(offsets, [COK]));
    expect(out.Objects.some((o: any) => o.name === "Flag_White")).toBe(false);
    expect(out.Objects.filter((o: any) => o.name === "Flag_Rooster")).toHaveLength(2);
  });

  it("spawns each object as many times as the template captured it", () => {
    // Quantity lives in the template: fifty WoodenLog entries, twenty
    // CommonBrick, and so on. Nothing is multiplied on the way out.
    const out = JSON.parse(generateSupplies(offsets, [COK])).Objects;
    const count = (name: string) => out.filter((o: any) => o.name === name).length;
    expect(count("WoodenLog")).toBe(50);
    expect(count("CommonBrick")).toBe(20);
    expect(count("DigitalCodeLock")).toBe(4);
    expect(count("Battery9V")).toBe(4);
  });

  it("gives each kit two flags, stacked at the template's flag offset", () => {
    // A spare, so a raided faction can re-raise without waiting for a sweep.
    // The template captured both at the same spot.
    const flags = JSON.parse(generateSupplies(offsets, [COK])).Objects.filter(
      (o: any) => o.name === "Flag_Rooster",
    );
    expect(flags).toHaveLength(2);
    expect(flags[0].pos).toEqual(flags[1].pos);
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
    const other = { tag: "WLF", texture: "Flag_Wolf", x: 100, y: 200, z: 300, supplied: true };
    const out = JSON.parse(generateSupplies(offsets, [COK, other]));
    expect(out.Objects).toHaveLength(244);
    expect(out.Objects.filter((o: any) => o.customString === "WLF")).toHaveLength(122);
  });

  it("⚠️ emits a clan's flags and nothing else when it is not supplied", async () => {
    // THE deadlock fix. Flags have nominal 0 / min 0 in types.xml, so the kit
    // is the only source of a clan's flag on the server. A raided clan that
    // dropped out of the file entirely could never raise, so could never
    // clear flag_down_since, so could never get its kit back — it just went
    // dormant. Losing the crate is the cost of a raid; losing the flag was a
    // dead end.
    const raided = { ...COK, supplied: false };
    const out = JSON.parse(generateSupplies(offsets, [raided]));
    expect(out.Objects).toHaveLength(2);
    expect(out.Objects.every((o: any) => o.name === "Flag_Rooster")).toBe(true);
    expect(out.Objects.every((o: any) => o.customString === "COK")).toBe(true);
  });

  it("puts an unsupplied clan's flags at the same pole offset as a supplied one's", async () => {
    // Same template entries, same offsets — only the rest of the kit is cut.
    const kitFlags = JSON.parse(generateSupplies(offsets, [COK])).Objects.filter((o: any) => o.name === "Flag_Rooster");
    const bare = JSON.parse(generateSupplies(offsets, [{ ...COK, supplied: false }])).Objects;
    expect(bare.map((o: any) => o.pos)).toEqual(kitFlags.map((o: any) => o.pos));
    expect(bare.map((o: any) => o.ypr)).toEqual(kitFlags.map((o: any) => o.ypr));
  });

  it("emits supplied kits and bare flags in one file, in the order given", async () => {
    // The sweep hands over one tag-ordered list, so the file still diffs in
    // faction order rather than splitting into two blocks.
    const wolf = { tag: "WLF", texture: "Flag_Wolf", x: 100, y: 200, z: 300, supplied: false };
    const out = JSON.parse(generateSupplies(offsets, [COK, wolf]));
    expect(out.Objects).toHaveLength(124);
    expect(out.Objects.filter((o: any) => o.customString === "COK")).toHaveLength(122);
    expect(out.Objects.filter((o: any) => o.customString === "WLF")).toHaveLength(2);
    expect(out.Objects[122].name).toBe("Flag_Wolf");
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
    expect(digest).toBe("6e6217133a695bb3133c8cecb40197b3144f45ad6047dac465688d294b40be8a");
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
