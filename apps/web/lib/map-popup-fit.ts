import type * as L from "leaflet";

/**
 * Keeping an open popup inside the map's box.
 *
 * ⚠️ Leaflet's ONLY answer to a popup that overruns its container is to pan
 * the map (`Popup._adjustPan` → `map.panBy`). This map cannot pan: map-view.tsx
 * sets `setMaxBounds(world)` with `maxBoundsViscosity: 1`, and the zoom floor
 * fits the whole world to the container — so at the floor there is no headroom
 * at all, and at any zoom the pan stops dead at the world's edge. A pin dropped
 * within half a card's width of the edge therefore had its popup clipped away
 * by `.leaflet-container`'s `overflow: hidden`: the note and the Delete button
 * off the page, with no gesture that could bring them back (2026-09-12).
 *
 * So the card moves instead of the map. `fitPopup` works out how far — pure,
 * and tested in test/map-popup-fit.test.ts — and `applyPopupFit` writes it as
 * two custom properties the card and the close button translate by (map.css),
 * leaving the tip behind, still pointing at the pin. Past the point where the
 * tip would slide off the card's own corner it is hidden instead: a pin's chip
 * frame already turns gold while its popup is open (`cw-open`), which is what
 * ties card to pin when the tip cannot.
 */

/** A box in the map container's own pixel coordinates. */
export type Box = { left: number; top: number; width: number; height: number };

/** The gutter kept between a fitted card and the container's edge. */
export const FIT_PAD = 8;

/** That gutter per side, so one edge can clear the map's own chrome. */
export type Pad = { top: number; right: number; bottom: number; left: number };
const EVEN: Pad = { top: FIT_PAD, right: FIT_PAD, bottom: FIT_PAD, left: FIT_PAD };

/** A box in page coordinates, as `getBoundingClientRect` gives it. */
export type Rect = { left: number; top: number; right: number; bottom: number; width: number; height: number };

/** The map's own chrome outside Leaflet's container, by id: map-view.tsx sets these, `applyPopupFit` measures them. */
export const CHROME_IDS = { corner: "map-corner", bar: "map-bar", notices: "map-notices" } as const;

/**
 * The gutter on each side of the map, taken from the chrome that paints over
 * it. ⚠️ Everything here paints above the popup pane (Leaflet's controls at
 * 1000, the site's at 1100; popups at 700), so a card fitted underneath any of
 * it opens hidden. Each box is measured, never guessed, and a `display: none`
 * box (zero size) is ignored, so the phone's hidden desktop chrome costs nothing.
 *
 * - zoom control (top-left) → the left gutter
 * - the sprocket and its layers panel (top-right) → the right gutter
 * - the desktop grid/refresh bar (bottom-left) → the bottom gutter
 * - the notices (top centre) → the top gutter
 *
 * A whole side for a corner's box is conservative on purpose: a card that
 * slides a little further than it strictly had to is still readable, and one
 * that lands under the panel is not.
 */
export function chromePad(view: Rect, chrome: { zoom?: Rect | null; corner?: Rect | null; bar?: Rect | null; notices?: Rect | null }): Pad {
  const shown = (r: Rect | null | undefined): r is Rect => r != null && r.width > 0 && r.height > 0;
  return {
    top: shown(chrome.notices) ? Math.max(FIT_PAD, chrome.notices.bottom - view.top + FIT_PAD) : FIT_PAD,
    right: shown(chrome.corner) ? Math.max(FIT_PAD, view.right - chrome.corner.left + FIT_PAD) : FIT_PAD,
    bottom: shown(chrome.bar) ? Math.max(FIT_PAD, view.bottom - chrome.bar.top + FIT_PAD) : FIT_PAD,
    left: shown(chrome.zoom) ? Math.max(FIT_PAD, chrome.zoom.right - view.left + FIT_PAD) : FIT_PAD,
  };
}

/**
 * A pin chip is 28 px square, anchored at its centre (`ICON.pin`), so 20 px
 * below the anchor clears its lower half with a gap to spare.
 */
export const FLIP_CLEAR = 20;

/** Set on the popup's root when the tip could not stay on the card. */
export const NO_TIP = "cw-no-tip";

/**
 * How far the tip may sit from the card's centre and still be under it: the
 * tip is ~24 px across, and 10 px keeps it clear of the squared corner.
 */
export function tipReach(cardWidth: number): number {
  return Math.max(0, cardWidth / 2 - 22);
}

export type Fit = {
  /** Pixels to move the card right (negative: left). */
  dx: number;
  /** Pixels to move the card down. */
  dy: number;
  /** Whether the tip still lands on the moved card. */
  tip: boolean;
};

/**
 * Where an open card has to move to sit wholly inside `view`.
 *
 * @param card    the card where Leaflet put it, in container coordinates
 * @param view    the map container's size
 * @param anchorY the pin's y in container coordinates — what a flip clears
 */
export function fitPopup(card: Box, view: { width: number; height: number }, anchorY: number, pad: Pad = EVEN): Fit {
  const dx = slide(card.left, card.width, view.width, pad);
  const overTop = pad.top - card.top;
  // Room below the card as Leaflet placed it; negative means it already overruns.
  const room = view.height - pad.bottom - (card.top + card.height);
  let dy = 0;
  if (overTop > 0) {
    // Sliding straight down would park the card on top of its own pin, so a
    // card that overruns the top flips BELOW the pin — clamped back to what the
    // container allows, and never less than the shift that clears the top.
    const flip = anchorY + FLIP_CLEAR - card.top;
    dy = Math.min(Math.max(flip, overTop), Math.max(room, overTop));
  } else if (room < 0) {
    dy = room;
  }
  return { dx, dy, tip: dy === 0 && Math.abs(dx) <= tipReach(card.width) };
}

/**
 * One axis. A card wider than the container is pinned to the left edge rather
 * than to the right: at least it then starts where the reading does.
 */
function slide(left: number, width: number, view: number, pad: Pad): number {
  if (left + width > view - pad.right) {
    const dx = view - pad.right - width - left;
    return left + dx < pad.left ? pad.left - left : dx;
  }
  if (left < pad.left) return pad.left - left;
  return 0;
}

/** Measure the open popup and write its fit. Safe to call as often as the view changes. */
export function applyPopupFit(map: L.Map, popup: L.Popup): void {
  const root = popup.getElement();
  if (!root) return;
  const card = root.querySelector<HTMLElement>(".leaflet-popup-content-wrapper");
  const at = popup.getLatLng();
  if (!card || !at) return;
  // ⚠️ The fit is measured from where LEAFLET put the card, not from where the
  // last call left it — otherwise every pan compounds the shift. Clearing the
  // properties first does not do that: the transform they feed needs no layout,
  // so `getBoundingClientRect` can hand back the shifted box anyway (Chrome
  // does). The shift already applied is subtracted instead, which is exact.
  const was = { x: px(root.style.getPropertyValue("--cw-fit-x")), y: px(root.style.getPropertyValue("--cw-fit-y")) };
  const box = card.getBoundingClientRect();
  const view = map.getContainer().getBoundingClientRect();
  // ⚠️ The chrome over the map, measured every time (chromePad above): the
  // zoom control is Leaflet's own, and the rest are the page's, found by id.
  const byId = (id: string) => document.getElementById(id)?.getBoundingClientRect() ?? null;
  const pad = chromePad(view, {
    zoom: map.getContainer().querySelector(".leaflet-control-zoom")?.getBoundingClientRect() ?? null,
    corner: byId(CHROME_IDS.corner),
    bar: byId(CHROME_IDS.bar),
    notices: byId(CHROME_IDS.notices),
  });
  const fit = fitPopup(
    { left: box.left - view.left - was.x, top: box.top - view.top - was.y, width: box.width, height: box.height },
    { width: view.width, height: view.height },
    map.latLngToContainerPoint(at).y,
    pad,
  );
  root.style.setProperty("--cw-fit-x", `${fit.dx}px`);
  root.style.setProperty("--cw-fit-y", `${fit.dy}px`);
  root.classList.toggle(NO_TIP, !fit.tip);
}

/** A `<length>px` custom property as a number; an unset one is no shift at all. */
function px(value: string): number {
  const n = Number.parseFloat(value);
  return Number.isFinite(n) ? n : 0;
}
