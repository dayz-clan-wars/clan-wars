import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { FIT_PAD, FLIP_CLEAR, fitPopup, tipReach } from "../lib/map-popup-fit";

/**
 * ⚠️ The bug these pin down: a pin dropped near the world's edge opened a popup
 * the map could not pan into view (maxBounds + maxBoundsViscosity 1 + a zoom
 * floor that fits the whole world), so `.leaflet-container`'s `overflow: hidden`
 * cut the note and the Delete button off the page (2026-09-12).
 */

/** A pin popup as map-draw.ts builds it: 13–16rem wide, a header, a note and the Delete button. */
const CARD = { width: 256, height: 170 };
const VIEW = { width: 390, height: 700 };

/** Where Leaflet puts the card for a pin at (x, y) in container coordinates: centred, 27 px above. */
const at = (x: number, y: number) => ({ left: x - CARD.width / 2, top: y - 27 - CARD.height, ...CARD });

describe("fitPopup", () => {
  it("leaves a card in the middle of the view alone, tip and all", () => {
    expect(fitPopup(at(195, 400), VIEW, 400)).toEqual({ dx: 0, dy: 0, tip: true });
  });

  it("slides a card off the west edge back inside", () => {
    const fit = fitPopup(at(40, 400), VIEW, 400);
    expect(fit.dx).toBe(FIT_PAD - (40 - 128));
    expect(at(40, 400).left + fit.dx).toBe(FIT_PAD);
    expect(fit.dy).toBe(0);
  });

  it("slides a card off the east edge back inside", () => {
    const card = at(360, 400);
    const fit = fitPopup(card, VIEW, 400);
    expect(card.left + fit.dx + card.width).toBe(VIEW.width - FIT_PAD);
    expect(fit.dx).toBeLessThan(0);
  });

  it("keeps the tip while it still lands on the card, and drops it past the corner", () => {
    expect(tipReach(CARD.width)).toBe(106);
    expect(fitPopup(at(195 - 100, 400), VIEW, 400).tip).toBe(true);
    // A pin hard against the west edge needs more shift than the tip can follow.
    expect(fitPopup(at(2, 400), VIEW, 400).tip).toBe(false);
  });

  it("flips a card that overruns the top BELOW its pin, never down over it", () => {
    const pinY = 30;
    const card = at(195, pinY);
    const fit = fitPopup(card, VIEW, pinY);
    expect(card.top + fit.dy).toBe(pinY + FLIP_CLEAR);
    expect(card.top + fit.dy + card.height).toBeLessThanOrEqual(VIEW.height - FIT_PAD);
    // A flipped card is nowhere near its tip.
    expect(fit.tip).toBe(false);
  });

  it("clamps a flip back when the container has no room for it", () => {
    const view = { width: 390, height: 200 };
    const pinY = 20;
    const card = at(195, pinY);
    const fit = fitPopup(card, view, pinY);
    expect(card.top + fit.dy + card.height).toBe(view.height - FIT_PAD);
    expect(card.top + fit.dy).toBeGreaterThanOrEqual(FIT_PAD);
  });

  it("fits the top first when the card is taller than the container", () => {
    const view = { width: 390, height: 120 };
    const card = at(195, 200);
    const fit = fitPopup(card, view, 200);
    expect(card.top + fit.dy).toBe(FIT_PAD);
  });

  it("lifts a card that overruns the bottom", () => {
    // A popup below its pin only happens on a flip, so the bottom case is a
    // short container: the card's own foot runs past it.
    const view = { width: 390, height: 150 };
    const card = { left: 60, top: 40, ...CARD };
    const fit = fitPopup(card, view, 240);
    expect(card.top + fit.dy + card.height).toBe(view.height - FIT_PAD);
  });

  it("takes a wider gutter on one side — the edge where the zoom control sits", () => {
    const pad = { top: FIT_PAD, right: FIT_PAD, bottom: FIT_PAD, left: 52 };
    const card = at(40, 400);
    expect(card.left + fitPopup(card, VIEW, 400, pad).dx).toBe(52);
    // An east-edge card still stops at the ordinary gutter.
    const east = at(360, 400);
    expect(east.left + fitPopup(east, VIEW, 400, pad).dx + east.width).toBe(VIEW.width - FIT_PAD);
  });

  it("pins a card wider than the container to the left edge, not the right", () => {
    const view = { width: 200, height: 700 };
    const card = at(100, 400);
    const fit = fitPopup(card, view, 400);
    expect(card.left + fit.dx).toBe(FIT_PAD);
  });
});

/**
 * The fit is opt-in twice over, and both opt-ins are invisible when missed: a
 * popup bound without `cw-map-popup` reads none of the custom properties the
 * fit writes, and a marker that never sets `cw-open` leaves a shifted card with
 * nothing tying it to its marker once the tip is hidden. Neither failure shows
 * up anywhere but on a phone, at the world's edge. So they are pinned here.
 */
describe("every popup on the map opts into the fit", () => {
  const draw = readFileSync(join(import.meta.dirname, "..", "app", "(site)", "map", "map-draw.ts"), "utf8");
  const css = readFileSync(join(import.meta.dirname, "..", "app", "(site)", "map", "map.css"), "utf8");
  // Up to the statement's own `);` — `text(age)` has parentheses of its own.
  const bindings = draw.match(/\.bindPopup\([\s\S]*?\);/gu) ?? [];

  it("binds at least the two popups this map has", () => {
    expect(bindings.length).toBeGreaterThanOrEqual(2);
  });

  it("passes the shared POPUP options to every one of them", () => {
    for (const binding of bindings) expect(binding).toContain("POPUP");
    expect(draw).toMatch(/const POPUP = \{ className: "cw-map-popup"/u);
  });

  it("marks every popup's marker open, so a hidden tip still has a tie", () => {
    expect(draw.match(/markOpen\(/gu)?.length).toBe(bindings.length + 1); // +1 for the declaration
  });

  it("styles the open frame for any chip, not just a pin's", () => {
    expect(css).toMatch(/^\.cw-open \.cw-chip-edge \{/mu);
  });
});
