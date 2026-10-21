import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { decodeAreaFlags, parseLimits } from "../lib/area-flags";

const fx = (name: string) => readFileSync(join(__dirname, "fixtures/mission", name), "utf8");

// A 2×2-cell map of a 100 m world, in the layout measured on Nasdara's areaflags.map:
// six LE uint32 header words, then a uint32 usage plane, then a uint8 value plane,
// both row-major with row 0 at z = 0 (the SOUTH edge).
function synthetic(cells: { usage: number; value: number }[]): Uint8Array {
  const n = 2 * 2;
  const buf = new Uint8Array(24 + n * 5);
  const dv = new DataView(buf.buffer);
  [2, 2, 100, 100, 32, 0].forEach((w, i) => dv.setUint32(i * 4, w, true));
  cells.forEach((c, i) => {
    dv.setUint32(24 + i * 4, c.usage, true);
    buf[24 + n * 4 + i] = c.value;
  });
  return buf;
}

describe("decodeAreaFlags", () => {
  // index = row * 2 + col: SW, SE, NW, NE
  const flags = decodeAreaFlags(
    synthetic([
      { usage: 0b1, value: 0b00100 }, // SW: Military, Tier3
      { usage: 0b10000000, value: 0b00001 }, // SE: Town, Tier1
      { usage: 0x80000000, value: 0b10000 }, // NW: top bit — must read unsigned
      { usage: 0b100000000, value: 0b00010 }, // NE: Village, Tier2
    ]),
  );

  it("reads the header", () => {
    expect(flags.cells).toBe(2);
    expect(flags.worldSize).toBe(100);
  });

  it("puts row 0 at the south edge (z = 0)", () => {
    expect(flags.at(10, 10)).toEqual({ usage: 0b1, value: 0b00100 });
    expect(flags.at(90, 10)).toEqual({ usage: 0b10000000, value: 0b00001 });
    expect(flags.at(10, 90)).toEqual({ usage: 0x80000000, value: 0b10000 });
    expect(flags.at(90, 90)).toEqual({ usage: 0b100000000, value: 0b00010 });
  });

  it("splits cells at their edges", () => {
    expect(flags.at(49.9, 49.9).value).toBe(0b00100);
    expect(flags.at(50, 49.9).value).toBe(0b00001);
    expect(flags.at(49.9, 50).value).toBe(0b10000);
  });

  it("reads nothing off the map", () => {
    expect(flags.at(-1, 10)).toEqual({ usage: 0, value: 0 });
    expect(flags.at(10, 100)).toEqual({ usage: 0, value: 0 });
  });

  it("refuses a buffer whose length disagrees with its header", () => {
    expect(() => decodeAreaFlags(synthetic([]).subarray(0, 40))).toThrow();
  });
});

describe("parseLimits", () => {
  it("keeps cfglimitsdefinition.xml order, which is bit order", () => {
    const limits = parseLimits(fx("cfglimitsdefinition.xml"));
    expect(limits.usage[0]).toBe("Military");
    expect(limits.usage).toHaveLength(19);
    expect(limits.value).toEqual(["Tier1", "Tier2", "Tier3", "Tier4", "Unique"]);
    expect(limits.value[3]).toBe("Tier4");
    expect(limits.categories[0]).toBe("tools");
    expect(limits.tags).toEqual(["floor", "shelves", "ground"]);
  });
});
