import { RULER_COPY } from "./map-copy";

/**
 * The map's ruler: distance and bearing between points the player clicks. Pure,
 * so the numbers are tested without Leaflet; map-draw.ts `drawRuler` puts them on
 * the map and map-ruler.tsx is the button.
 */
export type RulerPoint = { x: number; z: number };

/** The whole path, in metres: the legs added up. */
export function pathLength(points: readonly RulerPoint[]): number {
  let total = 0;
  for (let i = 1; i < points.length; i++) total += Math.hypot(points[i]!.x - points[i - 1]!.x, points[i]!.z - points[i - 1]!.z);
  return total;
}

/**
 * Compass degrees from `a` to `b`: 0 is north, clockwise.
 * ⚠️ North is +z (DayZ's z is the northing), so it is atan2(dx, dz), not the
 * maths-class atan2(dz, dx) — that one reads 90 for north and turns the wrong way.
 */
export function bearing(a: RulerPoint, b: RulerPoint): number {
  const deg = (Math.atan2(b.x - a.x, b.z - a.z) * 180) / Math.PI;
  return (deg + 360) % 360;
}

/** "740 m" under a kilometre, "2.3 km" from there. 999.6 m rounds up, so it reads "1.0 km", never "1000 m". */
export function formatDistance(m: number): string {
  const metres = Math.round(m);
  return metres < 1000 ? `${metres} m` : `${(m / 1000).toFixed(1)} km`;
}

/** "045°": three digits, like the in-game compass. 359.7 rounds to north. */
export function formatBearing(deg: number): string {
  return `${String(Math.round(deg) % 360).padStart(3, "0")}°`;
}

/** What the ruler says: what to do next until there is a leg, then the total and the last leg's bearing. */
export function rulerSummary(points: readonly RulerPoint[]): string {
  if (points.length === 0) return RULER_COPY.start;
  if (points.length === 1) return RULER_COPY.next;
  return `${formatDistance(pathLength(points))} · last leg ${formatBearing(bearing(points.at(-2)!, points.at(-1)!))}`;
}
