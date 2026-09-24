/**
 * Placing a pin. Two ways in: press-and-hold / right-click drops the draft on
 * the point pressed, and "Pin here" drops it on the map's centre and keeps it
 * there, under a cross, as the player pans. The second exists because the
 * first is invisible: no touch user discovers a long-press, and a keyboard
 * user has no right-click at all.
 */
export type PinDraft = { x: number; z: number; follow: boolean };

export function pinAtCentre(c: { x: number; z: number }): PinDraft {
  return { x: Math.round(c.x), z: Math.round(c.z), follow: true };
}

export function pinAtPoint(p: { x: number; z: number }): PinDraft {
  return { x: Math.round(p.x), z: Math.round(p.z), follow: false };
}

/**
 * On every moveend. A following draft moves with the centre; a draft dropped on
 * a point stays put. An unchanged draft comes back as the same object, so the
 * setState that calls this is a no-op on a pan that moved less than a metre.
 */
export function followCentre(d: PinDraft | null, c: { x: number; z: number }): PinDraft | null {
  if (!d || !d.follow) return d;
  const next = pinAtCentre(c);
  return next.x === d.x && next.z === d.z ? d : next;
}

/**
 * How far an overlay pushes the map's bottom edge up.
 *
 * ⚠️ The map cannot pan anything out from under an overlay: the world is its
 * max bounds with viscosity 1, and the zoom floor fits all of it. So anything
 * drawn over the container's bottom hides the south of the world for good,
 * and the map's box has to end where the overlay begins. Only an overlay that
 * spans the whole width can do that (the phone bar, the phone pin sheet). The
 * floating 360px desktop card and a `display: none` bar (0 wide) inset nothing.
 */
export function insetFor(overlay: { width: number; height: number }, viewWidth: number): number {
  return overlay.width > 0 && overlay.width >= viewWidth - 1 ? Math.round(overlay.height) : 0;
}

/**
 * Where focus goes when the pin sheet closes. The first candidate that is laid
 * out (`offsetParent` is null for `display: none` and for a detached node),
 * else the fallback. Structural, so it is testable without a DOM.
 */
export function pickReturnFocus<T extends { offsetParent: unknown }>(candidates: readonly T[], fallback: T | null): T | null {
  return candidates.find((c) => c.offsetParent !== null) ?? fallback;
}
