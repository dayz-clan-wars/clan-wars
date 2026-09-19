import { describe, expect, it } from "vitest";
import { generateBoosterKits } from "../src/booster-kits.js";

// x, y, z in database/spawner order: y is ALTITUDE.
const kit = {
  discordId: "1", gamertag: "Bob", texture: "Flag_Wolf",
  x: 5572.7, y: 312.8, z: 8811.8,
  items: ["GasMask", "GorkaEJacket_Summer"],
};

describe("generateBoosterKits", () => {
  it("emits every item plus the derived armband at the identical position", () => {
    const out = JSON.parse(generateBoosterKits([kit]));
    expect(out.Objects.map((o: any) => o.name)).toEqual(["GasMask", "GorkaEJacket_Summer", "Armband_Wolf"]);
    for (const o of out.Objects) expect(o.pos).toEqual([5572.7, 312.8, 8811.8]);
  });

  it("writes the stored columns out unswapped", () => {
    const out = JSON.parse(generateBoosterKits([kit]));
    expect(out.Objects[0].pos).toEqual([kit.x, kit.y, kit.z]);
  });

  it("emits no armband for a booster in no faction", () => {
    const out = JSON.parse(generateBoosterKits([{ ...kit, texture: null }]));
    expect(out.Objects.map((o: any) => o.name)).toEqual(["GasMask", "GorkaEJacket_Summer"]);
  });

  it("tags each object with the owner so an operator can trace a stray item", () => {
    const out = JSON.parse(generateBoosterKits([kit]));
    for (const o of out.Objects) expect(o.customString).toBe("Bob");
  });

  it("spawns nothing persistent", () => {
    const out = JSON.parse(generateBoosterKits([kit]));
    for (const o of out.Objects) expect(o.enableCEPersistency).toBe(0);
  });

  it("is byte-stable across runs with the same input", () => {
    expect(generateBoosterKits([kit])).toBe(generateBoosterKits([kit]));
  });

  it("emits an empty file for no kits", () => {
    expect(generateBoosterKits([])).toBe(`{"Objects":[]}`);
  });
});
