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
 * runbook's step 1 checks a landmark. If everything drawn is uniformly
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

/** "067 023": metres ÷ 100, truncated, zero-padded — what players say out loud. */
export function gridRef(x: number, z: number): string {
  const cell = (v: number) => String(Math.max(0, Math.floor(v / 100))).padStart(3, "0");
  return `${cell(x)} ${cell(z)}`;
}
