import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { GUIDE_GROUPS } from "@factions/domain";
import ChapterPage from "../app/guide/chapter";
import { CHAPTERS } from "../lib/guide";

const read = (...p: string[]) => readFileSync(join(import.meta.dirname, "..", "app", ...p), "utf8");

describe("the scoreboard and seasons tables (M3)", () => {
  it.each([["(site)", "scoreboard", "page.tsx"], ["(site)", "seasons", "page.tsx"]])("%s/%s: every <th> has a scope, and the table has a caption", (...p) => {
    const src = read(...p);
    const ths = [...src.matchAll(/<th\b[^>]*>/gu)].map((m) => m[0]);
    expect(ths.length).toBeGreaterThan(0);
    expect(ths.filter((t) => !/scope="col"/u.test(t))).toEqual([]);
    expect(src).toMatch(/<caption className="sr-only">/u);
  });
});

describe("the guide's Every number table (M3)", () => {
  const html = renderToStaticMarkup(createElement(ChapterPage, { chapter: CHAPTERS.find((c) => c.slug === "numbers")! }));

  it("has a header row a screen reader can announce", () => {
    expect(html).toMatch(/<thead class="sr-only"><tr><th scope="col">Rule<\/th><th scope="col">Value<\/th><\/tr><\/thead>/u);
  });

  it("⚠️ each group is a real row-group header, not a td dressed as one", () => {
    expect([...html.matchAll(/<th scope="rowgroup" colSpan="2">/giu)]).toHaveLength(GUIDE_GROUPS.length);
    expect([...html.matchAll(/<tbody>/gu)]).toHaveLength(GUIDE_GROUPS.length);
    expect(html).not.toMatch(/<td colSpan="2">/iu);
  });
});
