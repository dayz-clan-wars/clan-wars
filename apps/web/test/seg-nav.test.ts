import { describe, it, expect } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ScopePicker } from "../app/components/stat-boards";

/**
 * H2: ScopePicker adds one cell per season. From Season 3 the single row is
 * wider than a phone (All-time + S1–S3 ≈ 384px against ~335px), and it shows
 * on /players, every player page and every full board.
 */
describe("SegNav with five seasons", () => {
  // Newest first, as the roster returns `seasons`.
  const html = renderToStaticMarkup(createElement(ScopePicker, { seasons: [5, 4, 3, 2, 1], basePath: "/players", current: { kind: "season", number: 5 } }));

  it("renders All-time and every season", () => {
    expect([...html.matchAll(/<a /gu)]).toHaveLength(6);
  });

  it("⚠️ wraps onto a second row rather than running off a phone or scrolling the current season out of view", () => {
    expect(html).toContain("flex-wrap");
    expect(html).not.toMatch(/overflow-x-(auto|scroll)/u);
  });

  it("⚠️ no cell is flex-1 — a zero basis never wraps, so the row just overflows", () => {
    expect(html).not.toMatch(/\bflex-1\b/u);
    expect(html).toMatch(/\bflex-auto\b/u);
  });

  it("marks Season 5 current", () => {
    expect(html).toMatch(/href="\/players\?season=5"[^>]*aria-current="page"/u);
  });

  it("draws the focus ring inside the clipped frame, where it can be seen", () => {
    expect(html).toContain("focus-visible:outline-offset-[-3px]");
  });
});
