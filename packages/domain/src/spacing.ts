import { HUB_POSITION, MAP_EDGE_BUFFER_M, MIN_BASE_SPACING_M, WORLD_SIZE_M } from "./rules";

export type Point2 = { x: number; z: number };

/** Planar distance. Altitude is ignored on purpose: a base on a hill is still a base 150 m away. */
export function distance2d(a: Point2, b: Point2): number {
  return Math.hypot(a.x - b.x, a.z - b.z);
}

/**
 * The 200 m rule (guide ch. 4, "Spacing"). Returns the first declaration
 * closer than `minM`, or null when the candidate is allowed.
 *
 * ⚠️ The Hub is checked even when `existing` is empty. It is never a row in
 * `declarations` — it is not a base and is never published — so if it were
 * not injected here, the one place every traveller lands could be somebody's
 * watch zone. Spec §4.10.
 */
export function tooClose(candidate: Point2, existing: readonly Point2[], minM: number = MIN_BASE_SPACING_M): Point2 | null {
  for (const p of [HUB_POSITION, ...existing]) {
    if (distance2d(candidate, p) < minM) return { x: p.x, z: p.z };
  }
  return null;
}

/** True when the point is closer than `bufferM` to any edge of the map. */
export function nearMapEdge(p: Point2, bufferM: number = MAP_EDGE_BUFFER_M, worldM: number = WORLD_SIZE_M): boolean {
  return Math.min(p.x, p.z, worldM - p.x, worldM - p.z) < bufferM;
}
