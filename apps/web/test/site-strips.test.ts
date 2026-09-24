import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { SITE_STRIPS_ID, mapTop } from "../lib/site-strips";

const APP = join(import.meta.dirname, "..", "app", "(site)");

describe("mapTop", () => {
  it("is the top bar plus the strips' measured height", () => {
    expect(mapTop(90.4)).toBe("calc(var(--spacing-bar) + 90px)");
    expect(mapTop(0)).toBe("calc(var(--spacing-bar) + 0px)");
    expect(mapTop(-3)).toBe("calc(var(--spacing-bar) + 0px)");
  });
});

/**
 * ⚠️ The map is `fixed` from the top bar down; the strips under the bar are
 * ordinary flow. So the map painted straight over them: the raid countdown
 * invisible on the one page raiders plan from, and the install strip's
 * buttons still tabbable underneath it. The strips are wrapped once, in
 * the layout, and the map measures that wrapper.
 */
describe("the strips and the map", () => {
  it("wraps all three strips in one measurable element", () => {
    const layout = readFileSync(join(APP, "layout.tsx"), "utf8");
    expect(layout).toMatch(/<div id=\{SITE_STRIPS_ID\}>\s*<ServerStrip[^>]*\/>\s*<TimerBar[^>]*\/>\s*<InstallStrip \/>\s*<\/div>/u);
  });

  it("puts the map's top under them, and keeps it there as they change", () => {
    const view = readFileSync(join(APP, "map", "map-view.tsx"), "utf8");
    expect(view).toContain("document.getElementById(SITE_STRIPS_ID)");
    expect(view).toContain("main.style.top = mapTop(strips.offsetHeight)");
  });
});
