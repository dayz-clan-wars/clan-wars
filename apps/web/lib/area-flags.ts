/**
 * The Central Economy's areaflags.map: which usage (Military, Town, …) and which
 * value (Tier1–4, Unique) the server applies at each map position.
 *
 * Layout, measured on Nasdara's file (83,886,104 bytes) on 2026-10-21 rather than
 * taken from any description of the format:
 *
 *   header   six little-endian uint32s: cellsX, cellsZ, worldX, worldZ, 32, 0
 *            (Nasdara: 4096, 4096, 16384, 16384, 32, 0 — 4 m cells)
 *   usage    cellsX·cellsZ little-endian uint32 bitmasks, a whole PLANE
 *   value    cellsX·cellsZ uint8 bitmasks, a second plane straight after it
 *
 * Both planes are row-major, index = row·cellsX + col, with row 0 at z = 0 (the
 * south edge) — the opposite of the tile pyramid's y.
 *
 * How it was settled: every other candidate (interleaved 5-byte cells in either
 * order, planes value-first) sets usage bits above 18 and value bits above 4,
 * which cfglimitsdefinition.xml has no names for; usage-then-value sets neither.
 * For row order, 266 of mapgrouppos.xml's 388 Land_Mil_* buildings land on a
 * Military-bit cell with row 0 at the south edge, and 6 with it at the north;
 * Police stations 8/19 vs 0/19, medical buildings 17/60 vs 0/60. The value plane
 * shares that order: its hand-painted masks (anything but a single tier) sit
 * on usage-painted cells 31% of the time as decoded, 0.3% flipped.
 *
 * Bit k of each mask is the k-th entry of that list in cfglimitsdefinition.xml
 * (usage bit 0 = Military; value bit 0 = Tier1), which is why `parseLimits`
 * keeps document order.
 */

import { XMLParser } from "fast-xml-parser";

export type AreaFlags = { cells: number; worldSize: number; at(x: number, z: number): { usage: number; value: number } };

const HEADER_BYTES = 6 * 4;

export function decodeAreaFlags(buf: Uint8Array): AreaFlags {
  if (buf.byteLength < HEADER_BYTES) throw new Error(`areaflags: ${buf.byteLength} bytes is shorter than the header`);
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const [cellsX, cellsZ, worldX, worldZ] = [0, 1, 2, 3].map((i) => dv.getUint32(i * 4, true)) as [number, number, number, number];
  // The rest of the map assumes one square world; a rectangular file would need
  // separate x/z scales, and silently using one would misplace every lookup.
  if (cellsX !== cellsZ || worldX !== worldZ || cellsX === 0) {
    throw new Error(`areaflags: expected a square grid, got ${cellsX}×${cellsZ} cells over ${worldX}×${worldZ} m`);
  }
  const n = cellsX * cellsZ;
  // ⚠️ The length check is the only thing that catches a different layout: a
  // truncated or re-encoded file would otherwise decode into plausible-looking noise.
  if (buf.byteLength !== HEADER_BYTES + n * 5) {
    throw new Error(`areaflags: ${buf.byteLength} bytes, expected ${HEADER_BYTES + n * 5} for ${cellsX}² cells`);
  }
  const valueBase = HEADER_BYTES + n * 4;
  const cellM = worldX / cellsX;
  return {
    cells: cellsX,
    worldSize: worldX,
    at(x, z) {
      const col = Math.floor(x / cellM);
      const row = Math.floor(z / cellM); // ⚠️ row 0 is the south edge (z = 0); see the header
      if (!(col >= 0 && col < cellsX && row >= 0 && row < cellsZ)) return { usage: 0, value: 0 };
      const i = row * cellsX + col;
      // getUint32 is unsigned, so bit 31 cannot turn a mask negative.
      return { usage: dv.getUint32(HEADER_BYTES + i * 4, true), value: buf[valueBase + i]! };
    },
  };
}

type Named = { name: string };

/** cfglimitsdefinition.xml's four lists, in document order — which is bit order. */
export function parseLimits(xml: string): { usage: string[]; value: string[]; categories: string[]; tags: string[] } {
  // isArray: a list with one entry would otherwise parse as a bare object.
  const lists = ["category", "tag", "usage", "value"];
  const doc = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: "", isArray: (name) => lists.includes(name) }).parse(xml) as {
    lists?: {
      categories?: { category?: Named[] };
      tags?: { tag?: Named[] };
      usageflags?: { usage?: Named[] };
      valueflags?: { value?: Named[] };
    };
  };
  const l = doc.lists ?? {};
  const names = (xs: Named[] | undefined) => (xs ?? []).map((x) => x.name);
  return {
    usage: names(l.usageflags?.usage),
    value: names(l.valueflags?.value),
    categories: names(l.categories?.category),
    tags: names(l.tags?.tag),
  };
}
