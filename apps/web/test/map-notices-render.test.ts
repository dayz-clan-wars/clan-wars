import { describe, it, expect } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { MapNotices } from "../app/(site)/map/map-notices";
import { MAP_LOAD_COPY } from "../lib/map-copy";

const render = (props: Partial<Parameters<typeof MapNotices>[0]>) =>
  renderToStaticMarkup(createElement(MapNotices, { stale: false, onDismiss: () => {}, tone: "frame", ...props }));

describe("MapNotices", () => {
  it("gives a pin result a 44px Dismiss", () => {
    const html = render({ notice: "Pin dropped." });
    expect(html).toContain("Pin dropped.");
    expect(html).toContain('aria-label="Dismiss"');
    expect(html).toContain("h-11 w-11");
  });

  it("says a failed refresh on a neutral edge, never rust", () => {
    const html = render({ stale: true });
    expect(html).toContain(MAP_LOAD_COPY.stale);
    expect(html).toContain("border-rule-3");
    expect(html).not.toContain("rust");
  });

  it("renders nothing with nothing to say", () => {
    expect(render({})).toBe("");
  });
});

describe("where the desktop notices sit", () => {
  const view = readFileSync(join(import.meta.dirname, "..", "app", "(site)", "map", "map-view.tsx"), "utf8");

  it("is top centre, not over the zoom control's top-left corner", () => {
    expect(view).not.toContain("absolute left-6 top-6 z-[1100]");
    expect(view).toContain("absolute left-1/2 top-6 z-[1100]");
  });

  it("takes ?result out of the address, so a reload does not replay it", () => {
    expect(view).toContain("window.history.replaceState(window.history.state, \"\", withoutResult(window.location.href))");
  });
});
