import { describe, expect, it } from "vitest";
import { generateBoosterKits, KIT_SPAWN_LIFT_M } from "../src/booster-kits.js";

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
    for (const o of out.Objects) expect(o.pos).toEqual([5572.7, 313.05, 8811.8]);
  });

  it("writes the stored columns out unswapped, lifting only the altitude", () => {
    const out = JSON.parse(generateBoosterKits([kit]));
    expect(out.Objects[0].pos[0]).toBe(kit.x);
    expect(out.Objects[0].pos[2]).toBe(kit.z);
    expect(out.Objects[0].pos[1]).toBe(kit.y + KIT_SPAWN_LIFT_M);
  });

  /**
   * ⚠️ The reason the lift exists. The emote is performed standing on the
   * ground, so the recorded altitude IS ground level; spawning there put part
   * of a kit inside the floor where it could not be picked up. A test that
   * only checked "pos[1] is a number" would have passed the broken version,
   * so this pins the direction and the size.
   */
  it("spawns the gear above the marked ground, not level with it", () => {
    const out = JSON.parse(generateBoosterKits([kit]));
    for (const o of out.Objects) {
      expect(o.pos[1]).toBeGreaterThan(kit.y);
      expect(o.pos[1] - kit.y).toBeCloseTo(0.25, 10);
    }
  });

  /**
   * ⚠️ The tick HASHES these bytes to decide whether to re-upload, so the
   * lifted altitude must not serialise as a float tail like 313.05000000000007
   * — that would be stable but would also churn the file the first time it was
   * written and make every diff unreadable.
   */
  it("serialises the lifted altitude as a short decimal", () => {
    expect(generateBoosterKits([kit])).toContain('"pos":[5572.7,313.05,8811.8]');
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
