import { describe, expect, it } from "vitest";
import { KIT_SLOTS, loadCatalogue, isAllowed } from "../src/booster-kit";
import catalogue from "../assets/booster-catalogue.json";

const GOOD = {
  mask: [{ className: "GasMask", label: "Gas Mask" }],
  jacket: [{ className: "GorkaEJacket_Summer", label: "Gorka Jacket" }],
  eyewear: [], hat: [], pants: [], boots: [], gloves: [], hipPack: [], backpack: [],
};

describe("loadCatalogue", () => {
  it("accepts a file with an entry list for every slot", () => {
    const c = loadCatalogue(GOOD);
    expect(Object.keys(c).sort()).toEqual([...KIT_SLOTS].sort());
  });

  it("throws when a slot is missing, naming it", () => {
    const { backpack, ...missing } = GOOD;
    expect(() => loadCatalogue(missing)).toThrow(/backpack/);
  });

  it("throws on a duplicate class name within a slot", () => {
    const dup = { ...GOOD, mask: [...GOOD.mask, { className: "GasMask", label: "Again" }] };
    expect(() => loadCatalogue(dup)).toThrow(/GasMask/);
  });
});

describe("isAllowed", () => {
  it("is true for a class name in that slot", () => {
    expect(isAllowed(loadCatalogue(GOOD), "mask", "GasMask")).toBe(true);
  });

  it("is false for a class name from a different slot", () => {
    expect(isAllowed(loadCatalogue(GOOD), "mask", "GorkaEJacket_Summer")).toBe(false);
  });
});

it("the committed catalogue is valid", () => {
  expect(() => loadCatalogue(catalogue)).not.toThrow();
});
