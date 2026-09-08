import { describe, it, expect } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { createElement } from "react";
import { ScopePicker } from "../app/components/stat-boards";
import { parseSeasonParam } from "../lib/stat-scope";

/**
 * ⚠️ The All-time link must carry `?season=all`. A bare path parses as
 * "default", and the pages resolve "default" to the open season — so a bare
 * All-time link was a Season link wearing the wrong label, and every stat
 * from before the season started was unreachable from the picker.
 */
describe("ScopePicker", () => {
  const html = renderToStaticMarkup(createElement(ScopePicker, { seasons: [1], basePath: "/players", current: { kind: "season", number: 1 } }));
  const hrefs = [...html.matchAll(/href="([^"]*)"/gu)].map((m) => m[1]!.replace(/&amp;/gu, "&"));

  it("links All-time with ?season=all, and every season by number", () => {
    expect(hrefs).toEqual(["/players?season=all", "/players?season=1"]);
  });

  it("every link it renders parses to a real scope, never 'default'", () => {
    for (const href of hrefs) {
      const season = new URL(href, "https://x").searchParams.get("season") ?? undefined;
      expect(parseSeasonParam(season)).not.toBe("default");
    }
  });

  it("marks the current scope", () => {
    expect(html).toMatch(/href="\/players\?season=1"[^>]*aria-current="page"/u);
  });
});
