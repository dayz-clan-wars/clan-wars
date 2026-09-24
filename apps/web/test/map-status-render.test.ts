import { describe, it, expect } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { MapStatus } from "../app/(site)/map/map-status";
import { MAP_LOAD_COPY } from "../lib/map-copy";

const render = (view: Parameters<typeof MapStatus>[0]["view"]) => renderToStaticMarkup(createElement(MapStatus, { view, onRetry: () => {} }));

describe("MapStatus", () => {
  it("says the map is loading, in a live region", () => {
    const html = render("loading");
    expect(html).toContain('role="status"');
    expect(html).toContain(MAP_LOAD_COPY.loading);
  });

  it("says a first load failed, with a 44px retry, and never the 'refreshed' sentence", () => {
    const html = render("failed-first");
    expect(html).toContain(MAP_LOAD_COPY.failedFirst);
    expect(html).toContain(`>${MAP_LOAD_COPY.retry}</button>`);
    expect(html).toContain("min-h-[44px]");
    expect(html).not.toContain(MAP_LOAD_COPY.stale);
  });

  it("renders nothing over a working or stale map", () => {
    expect(render("ready")).toBe("");
    expect(render("stale")).toBe("");
  });
});

describe("the stale box is not rust", () => {
  const view = readFileSync(join(import.meta.dirname, "..", "app", "(site)", "map", "map-view.tsx"), "utf8");
  it("uses the control edge, since rust means an obligation owed", () => {
    expect(view).not.toContain("border-rust");
  });
});
