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
