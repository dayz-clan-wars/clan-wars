/**
 * World metres <-> the tile pyramid, and back again.
 *
 * ⚠️ The only place the coordinate flip is written down. DayZ's origin is
 * bottom-left with z as the northing; Leaflet's pixel origin is top-left with
 * y going down. Every drawn layer goes through `worldToLatLng`, so a sign
 * error here is a map that renders perfectly and is wrong everywhere.
 */

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

/** "043087": the grid ref with no space, for a URL (`/map?at=043087`). Six digits, so it can carry no metre coordinate. */
export function gridRefKey(x: number, z: number): string {
  return gridRef(x, z).replace(" ", "");
}

/** The centre of the cell a grid ref names, in metres — or null for anything that is not six digits inside the world. */
export function parseGridRef(key: string | null | undefined, size: number): { x: number; z: number } | null {
  if (!key || !/^\d{6}$/u.test(key)) return null;
  const cx = Number(key.slice(0, 3)), cz = Number(key.slice(3));
  const x = cx * 100 + 50, z = cz * 100 + 50;
  if (x > size || z > size) return null;
  return { x, z };
}

/** "067 023": metres ÷ 100, truncated, zero-padded — what players say out loud. */
export function gridRef(x: number, z: number): string {
  const cell = (v: number) => String(Math.max(0, Math.floor(v / 100))).padStart(3, "0");
  return `${cell(x)} ${cell(z)}`;
}
