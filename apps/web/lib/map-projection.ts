/**
 * World metres <-> the tile pyramid, and back again.
 *
 * ⚠️ The only place the coordinate flip is written down. DayZ's origin is
 * bottom-left with z as the northing; Leaflet's pixel origin is top-left with
 * y going down. Every drawn layer goes through `worldToLatLng`, so a sign
 * error here is a map that renders perfectly and is wrong everywhere.
 */

import { WORLD_SIZE_M } from "@factions/domain";

/**
 * One Life's pyramid: DZMap's loader tops out at zoom 6 → 256 * 2**6 px.
 *
 * ⚠️ Unverified against real tiles on this host — no mirrored tile set exists
 * here yet, so this is a documented assumption, not a measurement. The
 * runbook's step 7 checks a landmark. If everything drawn is uniformly
 * offset or scaled once real tiles are served, these two constants are what
 * to correct — `worldToPixel` takes `canvasPx` as a parameter precisely so
 * that stays a one-line fix. Do not "fix" `worldToPixel` itself: it is
 * unit-tested and correct by construction.
 */
export const MAX_ZOOM = 6;
export const CANVAS_PX = 256 * 2 ** MAX_ZOOM;

/** DayZ origin is bottom-left, z northing; Leaflet pixels are top-left, y down. */
export function worldToPixel(x: number, z: number, size: number, canvasPx = CANVAS_PX): [number, number] {
  const k = canvasPx / size;
  return [x * k, (size - z) * k];
}

export function worldToLatLng(x: number, z: number, size: number): { lat: number; lng: number } {
  const [px, py] = worldToPixel(x, z, size);
  const scale = 2 ** MAX_ZOOM;
  return { lat: -py / scale, lng: px / scale };
}

export function latLngToWorld(lat: number, lng: number, size: number): { x: number; z: number } {
  const scale = 2 ** MAX_ZOOM;
  const k = CANVAS_PX / size;
  return { x: (lng * scale) / k, z: size - (-lat * scale) / k };
}

/** Quarter steps: whole-level snapping makes a fractional zoom floor unreachable. */
export const ZOOM_SNAP = 0.25;

/**
 * The lowest zoom at which the world still covers the whole container, so
 * nothing outside the map is ever on screen. From One Life's map-canvas:
 * the pyramid is one 256px tile at zoom 0 and spans `256 * 2**z` px at
 * zoom z, so the floor is where that just covers the LONGER side —
 * `z >= log2(max(w, h) / 256)` — rounded UP to a snap point, which is what
 * makes it reachable: Leaflet rounds a zoom target to the snap first and
 * clamps to minZoom second, so a floor between snap points is rounded away
 * and the map bounces back a step.
 *
 * Null for a container measured as empty (log2(0) is -Infinity): a nonsense
 * floor clamps every gesture to a zoom whose tiles do not exist, and the
 * old behaviour is the better failure.
 */
export function zoomFloor(width: number, height: number, snap = ZOOM_SNAP, maxZoom = MAX_ZOOM): number | null {
  const exact = Math.log2(Math.max(width, height) / 256);
  const floor = Math.ceil(exact / snap) * snap;
  if (!Number.isFinite(floor) || floor > maxZoom) return null;
  return Math.max(0, floor);
}

/** "072106": the grid ref with no space, for a URL (`/map?at=072106`). Six digits, so it can carry no metre coordinate. */
export function gridRefKey(x: number, z: number, size = WORLD_SIZE_M): string {
  return gridRef(x, z, size).replace(" ", "");
}

/**
 * A grid key's whole shape: exactly six digits. The one statement of it —
 * lib/map-url.ts gates the `at` it writes into a URL on this same regex, so
 * the page never parses a key the redirect would not have written.
 *
 * ⚠️ GPS orientation, like the in-game GPS: the first number counts east from
 * the west edge, the second counts SOUTH from the top (north) edge. Old
 * `?at=` links written before 2026-10-21 counted z up from the bottom, so they
 * now land on the mirrored cell; the grid shape is unchanged, so nothing
 * rejects them.
 */
export const GRID_KEY = /^\d{6}$/u;

/** The centre of the cell a grid ref names, in metres — or null for anything that is not six digits inside the world. */
export function parseGridRef(key: string | null | undefined, size: number): { x: number; z: number } | null {
  if (!key || !GRID_KEY.test(key)) return null;
  const gx = Number(key.slice(0, 3)), gy = Number(key.slice(3));
  const x = gx * 100 + 50, z = size - (gy * 100 + 50);
  if (x > size || z < 0) return null;
  return { x, z };
}

/**
 * "072 087": x cell, then the cell counted DOWN from the north edge, zero-padded
 * — the in-game GPS. ⚠️ `size` is what makes z flip; a wrong size mirrors every
 * ref on the map without any error.
 */
export function gridRef(x: number, z: number, size = WORLD_SIZE_M): string {
  const cell = (v: number) => String(Math.max(0, Math.floor(v / 100))).padStart(3, "0");
  return `${cell(x)} ${cell(size - z)}`;
}

export const COORD_HINT = "Use GPS like 072 087, or metres like 7216 5706";

/** Null = not two numbers, so the caller treats the text as a name search. */
export type CoordQuery = { kind: "gps" | "metres"; x: number; z: number } | { kind: "bad"; hint: string } | null;

/**
 * Search-box coordinates. Three digits each is the GPS (cell numbers); four or
 * five each is metres. Mixed lengths, or anything else numeric, is `bad` rather
 * than a guess — a wrong guess flies the map to somewhere plausible and wrong.
 */
export function parseCoordQuery(input: string, size: number): CoordQuery {
  const parts = input.trim().split(/[\s,/]+/u);
  if (parts.length !== 2 || !parts.every((p) => /^\d+$/u.test(p))) return null;
  const bad: CoordQuery = { kind: "bad", hint: COORD_HINT };
  const [a, b] = parts as [string, string];
  if (a.length !== b.length) return bad;
  if (a.length === 3) {
    const x = Number(a) * 100 + 50, z = size - (Number(b) * 100 + 50);
    // ⚠️ Both cells are range-checked: a ref off the map is refused, never clamped onto the edge.
    if (x > size || z < 0) return bad;
    return { kind: "gps", x, z };
  }
  if (a.length === 4 || a.length === 5) {
    const x = Number(a), z = Number(b);
    if (x > size || z > size) return bad;
    return { kind: "metres", x, z };
  }
  return bad;
}
