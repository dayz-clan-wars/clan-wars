import { describe, it, expect } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { WarLogEntry } from "@factions/roster";
import { WarLogDays } from "../app/(site)/war-log/entry";

const raid = (at: string): WarLogEntry => ({
  kind: "raid", at: new Date(at), raider: { tag: "AAA", name: "Alpha" },
  victim: { tag: "BBB", name: "Bravo", texture: "Flag_Wolf" }, gamertag: "Ron", points: 12, lowers: 1,
});

/** M4: day headings were styled <div>s and entries <div>s — no heading or list shortcuts through a long log. */
describe("the war log's day groups", () => {
  const html = renderToStaticMarkup(createElement(WarLogDays, {
    entries: [raid("2026-09-20T22:14:00Z"), raid("2026-09-20T09:00:00Z"), raid("2026-09-19T18:30:00Z")],
  }));

  it("⚠️ one <h2> per UTC day", () => {
    expect([...html.matchAll(/<h2\b/gu)]).toHaveLength(2);
  });

  it("⚠️ each day's entries are a list", () => {
    expect([...html.matchAll(/<ul\b/gu)]).toHaveLength(2);
    expect([...html.matchAll(/<li\b/gu)]).toHaveLength(3);
  });

  it("says the day heading is in UTC", () => {
    expect(html).toMatch(/<h2[^>]*>.*UTC.*<\/h2>/u);
  });
});
