import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * ⚠️ Leaflet's stylesheet and the site's overrides of it restyle the same
 * selectors at the same specificity, so the sheet that comes LAST wins.
 * When the overrides sat in globals.css and map-view.tsx imported
 * leaflet.css on its own, Next emitted Leaflet's as a second sheet after
 * globals, and its `background: white` on the popup wrapper won: every pin
 * popup on a phone was a white card with the site's light ink on it — the
 * Delete button unreadable, reported as "delete doesn't work" (2026-09-11).
 * A desktop browser with forced dark mode hid it. There is no runtime signal
 * for a cascade order, so both halves are pinned structurally: the
 * overrides live in map.css, and map-view.tsx imports leaflet.css then
 * map.css, in that order, nothing between them.
 */
const WEB = join(import.meta.dirname, "..");
const MAP = join(WEB, "app", "(site)", "map");
const view = readFileSync(join(MAP, "map-view.tsx"), "utf8");
const mapCss = readFileSync(join(MAP, "map.css"), "utf8");
const globals = readFileSync(join(WEB, "app", "globals.css"), "utf8");

describe("Leaflet's CSS and the site's restyling of it", () => {
  it("are imported by map-view.tsx as a pair, Leaflet first", () => {
    expect(view).toMatch(/import "leaflet\/dist\/leaflet\.css";\nimport "\.\/map\.css";/u);
  });

  it("map.css paints the popup wrapper, tooltip and controls in the site's frame colour", () => {
    expect(mapCss).toMatch(/\.leaflet-popup-content-wrapper,[\s\S]*?\{\s*background: var\(--color-frame\)/u);
  });

  it("globals.css carries no Leaflet rule — a `.leaflet-` rule there would sit before Leaflet's sheet and lose", () => {
    expect(globals).not.toMatch(/\.leaflet-/u);
  });
});

/**
 * ⚠️ Leaflet's own rules for the zoom buttons' hover, focus and disabled
 * states, and for the popup close button, are one class MORE specific than
 * a plain restyle (`.leaflet-bar a:hover` against `.leaflet-bar a`). So they
 * won even from the earlier sheet:
 * - a #f4f4f4 box under ink (1.1:1) on every hover
 * - a grey disabled zoom-out on every load, because the map opens at its floor
 * - a 24px #757575 close cross (2.8:1)
 * Every override here has to match Leaflet's specificity; the later sheet
 * then wins.
 */
describe("Leaflet's control states, at Leaflet's own specificity", () => {
  const rule = (selector: RegExp): string => mapCss.match(new RegExp(`${selector.source}\\s*\\{([^}]*)\\}`, "u"))?.[1] ?? "";

  it("paints zoom hover and focus in the palette, not Leaflet's #f4f4f4", () => {
    const body = rule(/\.leaflet-bar a:hover,\s*\.leaflet-bar a:focus/u);
    expect(body).toContain("background: var(--color-surface)");
    expect(body).toContain("color: var(--color-gold)");
  });

  it("paints a disabled zoom button dim on the frame", () => {
    const body = rule(/\.leaflet-bar a\.leaflet-disabled/u);
    expect(body).toContain("background: var(--color-frame)");
    expect(body).toContain("color: var(--color-dim)");
  });

  it("sizes the zoom buttons 44px, above `.leaflet-touch .leaflet-bar a`'s 30px", () => {
    const body = rule(/\.leaflet-container \.leaflet-bar a/u);
    expect(body).toMatch(/width: 44px;/u);
    expect(body).toMatch(/height: 44px;/u);
    expect(body).toMatch(/line-height: 44px;/u);
  });

  it("gives the popup close button 44px and a readable colour, at `a.` specificity", () => {
    const body = rule(/\.cw-map-popup a\.leaflet-popup-close-button/u);
    expect(body).toMatch(/width: 44px;/u);
    expect(body).toMatch(/height: 44px;/u);
    expect(body).toContain("color: var(--color-muted)");
    expect(rule(/\.cw-map-popup a\.leaflet-popup-close-button:hover,\s*\.cw-map-popup a\.leaflet-popup-close-button:focus/u)).toContain("color: var(--color-ink)");
    // The unqualified form is (0,2,0) and loses to Leaflet's (0,2,1).
    expect(mapCss).not.toMatch(/\.cw-map-popup \.leaflet-popup-close-button/u);
  });
});

describe("popup text clears the 44px close button", () => {
  const draw = readFileSync(join(MAP, "map-draw.ts"), "utf8");

  it("pads every text-only popup's right edge by the button's width, and is at least as tall as it", () => {
    expect(draw).toMatch(/const POPUP_TEXT = "(?=[^"]*\bpr-11\b)(?=[^"]*min-h-\[44px\])[^"]*"/u);
    expect(draw.match(/\$\{POPUP_TEXT\}/gu)?.length).toBe(2);
  });

  it("pads the pin card's header the same way", () => {
    expect(draw).toContain("border-b border-rule-2 py-3 pl-3.5 pr-11");
  });
});
