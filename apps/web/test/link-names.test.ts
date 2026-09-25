import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { BOARD_KINDS, type Boards, type ScoreboardRow } from "@factions/roster";
import { StatBoards } from "../app/components/stat-boards";
import { TopRows } from "../app/components/score-rows";
import { BOARD_LABELS } from "../lib/stats-copy";

const read = (...p: string[]) => readFileSync(join(import.meta.dirname, "..", "app", "(site)", ...p), "utf8");

/** M9: ten identical "See all" links on /players, and "All →" twice more — indistinguishable in a screen reader's link list. */
describe("every link names where it goes", () => {
  const boards = { clans: {}, scope: { kind: "season", number: 1 }, seasons: [1], ...Object.fromEntries(BOARD_KINDS.map((k) => [k, []])) } as unknown as Boards;
  const html = renderToStaticMarkup(createElement(StatBoards, { boards, boardsPath: "/players/boards" }));

  it("⚠️ each See all carries its board's name", () => {
    for (const kind of BOARD_KINDS) expect(html).toContain(`<span class="sr-only">: ${BOARD_LABELS[kind]}</span>`);
  });

  it("the landing and clan pages' All links say whose log", () => {
    expect(read("page.tsx")).toMatch(/All<span className="sr-only"> war log entries<\/span>/u);
    // `&apos;` is how the JSX source spells the apostrophe; this reads the source.
    expect(read("clans", "[tag]", "page.tsx")).toMatch(/All<span className="sr-only"> of this clan&apos;s war log<\/span>/u);
  });
});

/** M10 (confirmed live): the landing scoreboard read "400 2 1" — three bare numbers. */
describe("the landing page's scoreboard rows", () => {
  const row: ScoreboardRow = { rank: 1, tag: "DR", name: "Dead Rabbits", texture: "Flag_Wolf", status: "active", points: 400, raids: 2, timesRaided: 1, defenses: 1, alpha: false };
  const html = renderToStaticMarkup(createElement(TopRows, { rows: [row] }));

  it("has a column header", () => {
    expect(html).toMatch(/aria-hidden="true"[^>]*>.*Pts.*Raids.*Def/u);
  });

  it("⚠️ says what each number is to a screen reader", () => {
    expect(html).toContain('400<span class="sr-only"> points</span>');
    expect(html).toContain('2<span class="sr-only"> raids</span>');
    expect(html).toContain('1<span class="sr-only"> defenses</span>');
  });
});
