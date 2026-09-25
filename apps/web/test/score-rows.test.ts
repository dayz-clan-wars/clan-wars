import { describe, it, expect } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { ScoreboardRow } from "@factions/roster";
import { CLAN_NAME_LENGTH } from "@factions/domain";
import { PhoneRows } from "../app/components/score-rows";

const row = (o: Partial<ScoreboardRow> = {}): ScoreboardRow => ({
  rank: 1, tag: "DR", name: "Dead Rabbits", texture: "Flag_Wolf", status: "active",
  points: 400, raids: 2, timesRaided: 1, defenses: 1, alpha: false, ...o,
});

/**
 * S1 (confirmed live at 375px): names truncated to "Dead R…" while the
 * "R / RD / D" column had room to spare, the header wrapped onto two lines,
 * and the tag was hidden. The counts now sit on a second line under the name.
 */
describe("/scoreboard's phone rows", () => {
  const html = renderToStaticMarkup(createElement(PhoneRows, { rows: [row(), row({ rank: 2, tag: "WWW", name: "W".repeat(CLAN_NAME_LENGTH.max) })] }));

  it("⚠️ gives the name the whole middle column, and the header never wraps", () => {
    expect(html).toContain("grid-cols-[32px_minmax(0,1fr)_auto]");
    expect(html).not.toContain("R / Rd / D");
    expect(html).toMatch(/aria-hidden="true" class="[^"]*whitespace-nowrap/u);
  });

  it("⚠️ a 32-character name wraps onto two lines inside its column instead of pushing the points off-screen", () => {
    expect(html).toMatch(/class="[^"]*line-clamp-2[^"]*\[overflow-wrap:anywhere\][^"]*">W{32}</u);
  });

  it("shows the tag and the counts in words on the phone", () => {
    expect(html).toContain("[DR]");
    expect(html).toContain("2 raids");
    expect(html).toContain("raided 1×");
    expect(html).toContain("1 defense");
  });

  it("names the points for a screen reader and lines numbers up", () => {
    expect(html).toMatch(/400<span class="sr-only"> points<\/span>/u);
    expect(html).toContain("tabular-nums");
  });

  /**
   * F9 (2026-09-24 review): the desktop table (scoreboard/page.tsx) already
   * says "Dormant · unranked" for a dormant clan that dropped off the
   * standings; the phone row said only "Dormant", leaving the bare em dash
   * from <Rank> as the only sign it had no rank at all.
   */
  it("⚠️ says unranked, not just dormant, when a dormant clan has no rank", () => {
    const withRank = renderToStaticMarkup(createElement(PhoneRows, { rows: [row({ status: "dormant" })] }));
    expect(withRank).toContain("Dormant");
    expect(withRank).not.toContain("unranked");

    const unranked = renderToStaticMarkup(createElement(PhoneRows, { rows: [row({ status: "dormant", rank: null })] }));
    expect(unranked).toContain("Dormant · unranked");
  });
});
