import { describe, it, expect } from "vitest";
import {
  BUNKER_KINDS, BUNKER_ROOMS, BUNKER_SPAWNER_PATH, bunkerRoom, bunkerRoomName, bunkerTemplateFile, placeBunker,
  type SpawnerObject,
} from "../src/index.js";

const obj = (name: string, pos: [number, number, number], ypr: [number, number, number] = [0, 0, 0]): SpawnerObject =>
  ({ name, pos, ypr, scale: 1, enableCEPersistency: 0, customString: "" });
const ANCHOR = obj("Land_Underground_Stairs_Exit", [100, 10, 200], [0, 0, 0]);
const template = (...rest: SpawnerObject[]) => ({ Objects: [ANCHOR, ...rest] });

describe("rooms and kinds", () => {
  it("has the 11 rooms with unique slugs, and two kinds", () => {
    expect(BUNKER_ROOMS).toHaveLength(11);
    expect(new Set(BUNKER_ROOMS.map((r) => r.slug)).size).toBe(11);
    expect(bunkerRoom("kamensk-military")?.name).toBe("Kamensk Military");
    expect(bunkerRoom("dolnik")).toBeNull();
    expect(BUNKER_KINDS).toEqual(["boom", "guns"]);
    expect(bunkerTemplateFile("guns")).toBe("keycard-bunker-guns.json");
    expect(BUNKER_SPAWNER_PATH).toBe("./custom/bunker-online.json");
  });
  it("names a room, a retired Livonia location, or falls back to the slug", () => {
    expect(bunkerRoomName("nwaf")).toBe("NWAF");
    expect(bunkerRoomName("dolnik")).toBe("Dolnik");
    expect(bunkerRoomName("narnia")).toBe("narnia");
  });
});

describe("placeBunker", () => {
  it("at the anchor's own yaw, every object keeps its offset from the room's exit; the template's exit is left out", () => {
    const out = placeBunker(template(obj("Crate", [101, 11, 203], [10, 0, 0])), { x: 1000, y: 50, z: 2000, yaw: 0 });
    expect(out.Objects).toEqual([obj("Crate", [1001, 51, 2003], [10, 0, 0])]);
  });
  // DayZ yaw is clockwise from north (+z): turning 90° moves a point east of the
  // anchor to south of it.
  it("turned 90°, an offset 1 m east lands 1 m south, and its yaw turns by 90", () => {
    const out = placeBunker(template(obj("Crate", [101, 10, 200], [0, 0, 0])), { x: 1000, y: 50, z: 2000, yaw: 90 });
    const [c] = out.Objects;
    expect(c!.pos[0]).toBeCloseTo(1000, 9); expect(c!.pos[1]).toBe(50); expect(c!.pos[2]).toBeCloseTo(1999, 9);
    expect(c!.ypr[0]).toBeCloseTo(90, 9);
  });
  it("turned 90°, an offset 1 m north lands 1 m east", () => {
    const [c] = placeBunker(template(obj("Crate", [100, 10, 201])), { x: 0, y: 0, z: 0, yaw: 90 }).Objects;
    expect(c!.pos[0]).toBeCloseTo(1, 9); expect(c!.pos[2]).toBeCloseTo(0, 9);
  });
  // ⚠️ Review focus 4: the concrete panels are [90, 90, 180]; only yaw may move.
  it("keeps pitch and roll exactly", () => {
    const [c] = placeBunker(template(obj("StaticObj_Panel_Concrete_1", [101, 11, 201], [90, 89.97, 180])), { x: 0, y: 0, z: 0, yaw: -45 }).Objects;
    expect(c!.ypr[1]).toBe(89.97); expect(c!.ypr[2]).toBe(180);
    expect(c!.ypr[0]).toBeCloseTo(45, 9);
  });
  // ⚠️ Review focus 5.
  it("normalises yaw into (-180, 180]", () => {
    const [c] = placeBunker(template(obj("Crate", [101, 10, 200], [170, 0, 0])), { x: 0, y: 0, z: 0, yaw: 90 }).Objects;
    expect(c!.ypr[0]).toBeCloseTo(-100, 9);
    const [d] = placeBunker(template(obj("Crate", [101, 10, 200], [0, 0, 0])), { x: 0, y: 0, z: 0, yaw: -180 }).Objects;
    expect(d!.ypr[0]).toBeCloseTo(180, 9);
  });
  it("copies name, scale, persistency and customString", () => {
    const o = { ...obj("Mag_SVD_10Rnd", [101, 10, 200]), scale: 0.5, enableCEPersistency: 1, customString: "x" };
    const [c] = placeBunker(template(o), { x: 0, y: 0, z: 0, yaw: 0 }).Objects;
    expect(c).toMatchObject({ name: "Mag_SVD_10Rnd", scale: 0.5, enableCEPersistency: 1, customString: "x" });
  });
  it("refuses a template with no stairs exit, or two", () => {
    expect(() => placeBunker({ Objects: [obj("Crate", [0, 0, 0])] }, { x: 0, y: 0, z: 0, yaw: 0 })).toThrow(/one Land_Underground_Stairs_Exit, found 0/);
    expect(() => placeBunker(template(ANCHOR), { x: 0, y: 0, z: 0, yaw: 0 })).toThrow(/found 2/);
  });
});
