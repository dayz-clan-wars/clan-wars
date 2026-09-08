import data from "./map-places.json";

/**
 * Place names for the map, vendored from DZMap's location data by
 * `scripts/refresh-map-places.mjs` (the same source as the mirrored tiles).
 * Copied from One Life, where the tiering below was worked out.
 *
 * ⚠️ `lat`/`lng` are ALREADY Leaflet CRS.Simple coordinates on the zoom-6
 * pyramid — the same frame `worldToLatLng` produces — and are never
 * re-projected. A name is not a position of anyone's; spec §10.3 is about
 * players, and a town is on every map already.
 */
export type MapPlace = {
  /** DZMap's category: capital | city | village | local | camp | hill | ruin | marine. */
  kind: string;
  lat: number;
  lng: number;
  name: string;
};

const PLACES = data as Record<string, MapPlace[]>;

/**
 * The zoom at which each category starts being labelled. Drawn all at once
 * the sixty names bury the markers the map exists to show: cities orient
 * you zoomed out, villages appear once a region fills the screen, and the
 * hills, camps, ruins and landmarks only once you are reading one valley.
 * An unknown category falls to the most restrictive tier, so a DayZ update
 * cannot flood the zoomed-out view.
 */
const MIN_ZOOM: Record<string, number> = { capital: 0, city: 0, village: 2 };
export const PLACE_FALLBACK_MIN_ZOOM = 4;

export function placeMinZoom(kind: string): number {
  return MIN_ZOOM[kind] ?? PLACE_FALLBACK_MIN_ZOOM;
}

/** Every place to label on this map at this zoom. Unknown map ⇒ none, never a throw. */
export function placesFor(map: string, zoom: number): MapPlace[] {
  const all = PLACES[map];
  if (!all) return [];
  return all.filter((p) => zoom >= placeMinZoom(p.kind));
}

/** The label's weight: settlements read louder than terrain features. */
export function placeWeight(kind: string): "major" | "minor" | "faint" {
  if (kind === "capital" || kind === "city") return "major";
  if (kind === "village") return "minor";
  return "faint";
}
