import { MIN_BASE_SPACING_M } from "./rules";

export type Point2 = { x: number; z: number };

/** Planar distance. Altitude is ignored on purpose: a base on a hill is still a base 150 m away. */
export function distance2d(a: Point2, b: Point2): number {
  return Math.hypot(a.x - b.x, a.z - b.z);
}

/**
 * The 200 m rule (guide ch. 4, "Spacing"). Returns the first declaration
 * closer than `minM`, or null when the candidate is allowed.
 */
export function tooClose(candidate: Point2, existing: readonly Point2[], minM: number = MIN_BASE_SPACING_M): Point2 | null {
  for (const p of existing) {
    if (distance2d(candidate, p) < minM) return { x: p.x, z: p.z };
  }
  return null;
}
