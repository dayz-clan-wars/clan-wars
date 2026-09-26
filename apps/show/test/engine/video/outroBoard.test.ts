import { describe, it, expect, test } from "vitest";
import { Resvg } from "@resvg/resvg-js";
import { buildOutroBoardSvg, renderOutroBoardPng, type OutroBoard, type ResvgCtor } from "../../../src/engine/video/outroBoard.js";
import { ASSETS } from "../../../src/assets.js";

// Ported and reshaped from KOTH bot/test/video/leaderboardImage.test.js at a5ef8e7. KOTH drew one
// column per map (Chernarus/Livonia) with rank, gamertag and crown count as three separately
// positioned <text> elements; this plan (spec §12, task-8 brief) draws a single Clan Wars column
// of clan rows -- "<rank>. <name>  <points> pts · <raids> raids" -- in ONE <text> element per row
// so every row stays single-font (KOTH b954fe3). The headline is drawn as given, never uppercased
// or built up from a season/week pair (that composition now happens in src/cards/ per plan). Tests
// about the two-column map layout, the week-number suffix and the empty-column placeholder text
// are dropped as no longer applicable; a zero-row-board test and an ink-count ligature regression
// test replace them per the task-8 brief.

const board: OutroBoard = {
  headline: "CLAN WARS · SEASON 1 · AFTER WEEK 3",
  rows: [
    { name: "YrJustBad", points: 42, raids: 11 },
    { name: "A&B", points: 7, raids: 2 },
  ],
};

const svg = (extra: Partial<Parameters<typeof buildOutroBoardSvg>[0]> = {}) =>
  buildOutroBoardSvg({
    board,
    backgroundDataUri: "data:image/png;base64,ZZZ",
    displayFamily: "Animals are like people",
    gamertagFamily: "Patrick Hand",
    ...extra,
  });

describe("buildOutroBoardSvg", () => {
  it("draws the headline as given and each row's rank, name, points and raids", () => {
    const s = svg();
    expect(s).toContain("CLAN WARS · SEASON 1 · AFTER WEEK 3");
    expect(s).toContain("YrJustBad");
    expect(s).toContain("42");
    expect(s).toContain("pts");
    expect(s).toContain("11");
    expect(s).toContain("raids");
    expect(s).toContain("1.");
    expect(s).toContain("2.");
  });

  it("caps at 5 rows", () => {
    const many: OutroBoard = {
      headline: "H",
      rows: Array.from({ length: 8 }, (_, i) => ({ name: `Clan${i}`, points: i, raids: i })),
    };
    const s = svg({ board: many });
    expect(s).toContain("Clan0");
    expect(s).toContain("Clan4");
    expect(s).not.toContain("Clan5");
  });

  it("a zero-row board renders (headline only)", () => {
    const s = svg({ board: { headline: "NO RAIDS", rows: [] } });
    expect(s).toContain("NO RAIDS");
    expect(s).toContain("<svg");
  });

  it("XML-escapes a row name with <, & and \"", () => {
    const s = svg({ board: { headline: "H", rows: [{ name: 'A<b>&"c', points: 1, raids: 1 }] } });
    expect(s).toContain("A&lt;b&gt;&amp;&quot;c");
    expect(s).not.toContain('A<b>&"c');
  });

  it("embeds the background and the scrim", () => {
    const s = svg();
    expect(s).toContain("data:image/png;base64,ZZZ");
    expect(s).toContain('fill-opacity="0.45"');
  });

  it("keeps each row in a single font-family (KOTH b954fe3)", () => {
    const s = svg();
    const rowMatches = [...s.matchAll(/<text[^>]*>((?:(?!<\/text>).)*)<\/text>/gs)].filter((m) => m[1]!.includes("YrJustBad"));
    expect(rowMatches).toHaveLength(1);
    const [full] = rowMatches[0]!;
    expect((full.match(/font-family="[^"]*"/g) || []).length).toBe(1);
  });
});

// Render one outro row and count the "ink" (non-background pixels) in the centre of that row's
// y-band, away from the board border, so a blanked row reads as ~0 ink. Copied from the screenWall
// test's rowInk helper (Task 7): a "fi" ligature in a mixed-font <text> element silently dropped
// the whole element in resvg (KOTH b954fe3), invisible at the SVG-string level.
function rowInk(name: string): number {
  const s = buildOutroBoardSvg({
    board: { headline: "H", rows: [{ name, points: 9, raids: 9 }] },
    backgroundDataUri: "data:image/png;base64,ZZZ",
    displayFamily: "Animals are like people",
    gamertagFamily: "Patrick Hand",
  });
  const { pixels, width } = new Resvg(s, {
    background: "#0a0b0d",
    fitTo: { mode: "width", value: 1920 },
    font: {
      fontFiles: [ASSETS.fonts.display, ASSETS.fonts.gamertag],
      defaultFontFamily: "Animals are like people",
      loadSystemFonts: false,
    },
  }).render();
  let ink = 0;
  for (let y = 280; y <= 360; y++) {
    for (let x = 300; x <= 1400; x++) {
      const i = (y * width + x) * 4;
      if (pixels[i]! > 40 || pixels[i + 1]! > 40 || pixels[i + 2]! > 40) ink++;
    }
  }
  return ink;
}

test('a gamertag containing an "fi" ligature still renders in an outro board row (not blanked by resvg)', () => {
  const control = rowInk("Zade zzzzy69"); // no ligature, same length: guards the band/threshold itself
  const ligature = rowInk("Fade fishy69"); // contains "fi"
  expect(control).toBeGreaterThan(300);
  expect(ligature).toBeGreaterThan(300);
});

describe("renderOutroBoardPng", () => {
  test("embeds the bg, loads both fonts (no system fonts), returns the rasterized bytes", () => {
    let resvgArgs: { svg: string; opts: Record<string, unknown> } | undefined;
    const fsImpl = { readFileSync: (p: string) => Buffer.from(`BYTES:${p}`) };
    class FakeResvg {
      constructor(svg: string, opts: Record<string, unknown>) {
        resvgArgs = { svg, opts };
      }
      render() {
        return { asPng: () => Buffer.from("PNGBYTES") };
      }
    }
    const out = renderOutroBoardPng(
      {
        board,
        backgroundPath: "/a/outro.png",
        displayFontPath: "/a/display.ttf",
        gamertagFontPath: "/a/gamer.ttf",
      },
      { fsImpl, ResvgImpl: FakeResvg as unknown as ResvgCtor },
    );

    expect(out).toEqual(Buffer.from("PNGBYTES"));
    expect(resvgArgs!.svg).toContain("YrJustBad");
    expect(resvgArgs!.svg).toContain("data:image/png;base64,");
    expect((resvgArgs!.opts as { font: { fontFiles: string[] } }).font.fontFiles).toEqual(["/a/display.ttf", "/a/gamer.ttf"]);
    expect((resvgArgs!.opts as { font: { loadSystemFonts: boolean } }).font.loadSystemFonts).toBe(false);
  });
});
