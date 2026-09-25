import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { BoardRows } from "../app/components/stat-boards";

const read = (...p: string[]) => readFileSync(join(import.meta.dirname, "..", "app", "(site)", ...p), "utf8");

/** L1: proportional digits make a right-aligned column of numbers ragged. */
describe("number columns use tabular figures", () => {
  it("a board's value and K/D", () => {
    const html = renderToStaticMarkup(createElement(BoardRows, { kind: "kd", rows: [{ dayzId: "1", gamertag: "Ron", value: 2.5, kills: 10, deaths: 4 }], clans: {} }));
    expect([...html.matchAll(/tabular-nums/gu)].length).toBeGreaterThanOrEqual(2);
  });

  it.each([["scoreboard"], ["seasons"]])("/%s's number cells", (p) => {
    const src = read(p, "page.tsx");
    expect(src).toMatch(/const num = "[^"]*tabular-nums/u);
    expect(src).toMatch(/text-right font-display[^"`]*tabular-nums/u);
  });

  it("/alphas's points", () => {
    expect(read("alphas", "page.tsx")).toMatch(/ml-auto font-display[^"]*tabular-nums/u);
  });
});
