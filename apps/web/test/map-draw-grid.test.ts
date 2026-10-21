import { describe, expect, it } from "vitest";
import { drawGrid } from "../app/(site)/map/map-draw";

describe("drawGrid", () => {
  it("anchors horizontals to the north edge, like the GPS rows", () => {
    const lines: Array<[{ x: number; z: number }, { x: number; z: number }]> = [];
    const L = {
      polyline: (pts: Array<{ x: number; z: number }>) => {
        lines.push([pts[0]!, pts[1]!]);
        return { addTo: () => undefined };
      },
    };
    const size = 16384;
    drawGrid(L as never, {} as never, (x, z) => ({ x, z }) as never, size);
    const horizontals = lines.filter(([a, b]) => a.z === b.z);
    expect(horizontals[0]![0].z).toBe(size);
    expect(horizontals[1]![0].z).toBe(size - 1000);
    expect(horizontals.at(-1)![0].z).toBe(size - 16000);
  });
});
