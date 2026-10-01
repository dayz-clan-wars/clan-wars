import { describe, it, expect } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { Rich } from "../app/(site)/live/rich";
import { LiveCardView } from "../app/(site)/live/live-card";
import { when } from "../lib/format";

describe("Rich", () => {
  it("links players and clans and prints time in UTC", () => {
    const html = renderToStaticMarkup(createElement(Rich, { line: [{ bold: [{ player: "Al pha" }] }, " [", { clan: "WLF" }, "] ", { time: "2026-09-07T22:14:00.000Z", style: "at" }] }));
    expect(html).toContain('href="/players/Al%20pha"');
    expect(html).toContain('href="/clans/WLF"');
    expect(html).toContain(when(new Date("2026-09-07T22:14:00.000Z")));
  });
  it("escapes player text rather than rendering it as HTML", () => {
    expect(renderToStaticMarkup(createElement(Rich, { line: [{ raw: "<b>x</b>" }] }))).toContain("&lt;b&gt;");
  });
});

describe("LiveCardView", () => {
  it("draws the flag thumbnail, a warn title in rust and the stamp", () => {
    const html = renderToStaticMarkup(createElement(LiveCardView, { item: {
      id: 1, at: "2026-09-07T22:14:00.000Z", title: [{ player: "A" }], href: "/players/A", lines: [["x"]], detail: [["d"]],
      flag: "Flag_Wolf", badge: null, tone: "warn",
    } }));
    expect(html).toContain("/flags/thumb/Flag_Wolf.webp");
    expect(html).toContain("text-rust");
    expect(html).toContain(when(new Date("2026-09-07T22:14:00.000Z")));
  });
});
