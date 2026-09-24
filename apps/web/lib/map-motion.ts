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

/**
 * ⚠️ Leaflet's popup `autoPan` (default on) pans the WHOLE MAP, animated,
 * whenever a popup opens near the container edge — a `map.panBy` Leaflet
 * drives itself, independent of `zoomAnimation`/`fadeAnimation`/`inertia`
 * above, so it needs its own guard rather than riding theirs.
 * `lib/map-popup-fit.ts`'s `applyPopupFit` already keeps the card itself on
 * screen without moving the map, so this only ever turns autoPan OFF under
 * reduced motion; a visitor with no preference keeps Leaflet's default.
 */
export function popupOptions<T extends object>(base: T): T & { autoPan: boolean } {
  return { ...base, autoPan: !prefersReducedMotion() };
}
