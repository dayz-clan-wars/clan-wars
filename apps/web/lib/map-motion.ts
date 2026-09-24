/**
 * Leaflet's motion, off for a visitor who has asked for less. map.css already
 * stills the intruder's pulse under this query, but Leaflet animates zoom,
 * fades tiles, slides markers and throws a pan on with inertia of its own,
 * and none of that reads CSS.
 */
export const REDUCED_MOTION = "(prefers-reduced-motion: reduce)";

export function motionOptions(reduced: boolean): { zoomAnimation: boolean; fadeAnimation: boolean; markerZoomAnimation: boolean; inertia: boolean } {
  return { zoomAnimation: !reduced, fadeAnimation: !reduced, markerZoomAnimation: !reduced, inertia: !reduced };
}

/** Read at the moment of use, so a change in the OS setting applies to the next zoom without a reload. */
export function prefersReducedMotion(): boolean {
  try {
    return typeof window !== "undefined" && window.matchMedia(REDUCED_MOTION).matches;
  } catch {
    return false;
  }
}
