import { describe, it, expect, test } from "vitest";
import { Resvg } from "@resvg/resvg-js";
import { buildCardSvg, buildScreenClipArgs, buildScreenClip, type ResvgCtor } from "../../../src/engine/animation/screenWall.js";
import type { Run } from "../../../src/engine/run.js";
import { ASSETS } from "../../../src/assets.js";

// Ported from KOTH bot/test/animation/screenWall.test.js at a5ef8e7. `screenCards` is dropped per
// the task-7 brief (replaced by src/cards/ in a later task), so its test is dropped too. Card shape
// is renamed `mapLabel` -> `header` per the brief.

describe("buildCardSvg", () => {
  it("renders the header, title and rows", () => {
    const svg = buildCardSvg({
      header: "CHERNARUS",
      title: "MOST KILLS",
      rows: [{ name: "Ava", value: "42" }],
      width: 742,
      height: 494,
      displayFamily: "D",
      gamertagFamily: "G",
    });
    expect(svg).toContain("MOST KILLS");
    expect(svg).toContain("Ava");
    expect(svg).toContain("42");
  });

  it("XML-escapes a row name with <, & and \"", () => {
    const svg = buildCardSvg({
      header: "CHERNARUS",
      title: "MOST KILLS",
      rows: [{ name: 'A<b>&"c', value: "1" }],
      width: 742,
      height: 494,
      displayFamily: "D",
      gamertagFamily: "G",
    });
    expect(svg).toContain("A&lt;b&gt;&amp;&quot;c");
    expect(svg).not.toContain('A<b>&"c');
  });
});

describe("buildScreenClipArgs", () => {
  it("lists one input per card and an xfade chain", () => {
    const args = buildScreenClipArgs({
      cardPaths: ["/a.png", "/b.png"],
      holdSec: 3,
      xfSec: 0.5,
      fps: 12,
      width: 742,
      height: 494,
      outPath: "/o.mp4",
    });
    expect(args.filter((a) => a === "/a.png" || a === "/b.png")).toHaveLength(2);
    expect(args.join(" ")).toContain("xfade");
    expect(args[args.length - 1]).toBe("/o.mp4");
  });
});

describe("buildScreenClip", () => {
  it("rasterizes each card and runs ffmpeg", async () => {
    const writes: string[] = [];
    const fsImpl = { writeFileSync: (p: string) => writes.push(p) };
    const ResvgImpl = class {
      render() {
        return { asPng: () => Buffer.from([1]) };
      }
    } as unknown as ResvgCtor;
    let ran: string[] | null = null;
    const runImpl: Run = async (_cmd, args) => {
      ran = args;
      return Buffer.alloc(0);
    };
    const cards = [
      { header: "CHERNARUS", title: "MOST KILLS", rows: [{ name: "Ava", value: "42" }] },
      { header: "CHERNARUS", title: "MOST CROWNS", rows: [{ name: "Ava", value: "3" }] },
    ];
    const out = await buildScreenClip(
      { ResvgImpl, runImpl, fsImpl },
      {
        cards,
        durSec: 12,
        fps: 12,
        outPath: "/o.mp4",
        workDir: "/w",
        displayFontPath: "/d.ttf",
        gamertagFontPath: "/g.ttf",
      },
    );
    expect(out).toBe("/o.mp4");
    expect(writes).toHaveLength(2); // two card PNGs
    expect(ran).not.toBeNull();
    expect(ran![ran!.length - 1]).toBe("/o.mp4");
  });
});

// Render one stat card with a single row and count the "ink" (non-background pixels) in the centre
// of that row's y-band, away from the card border, so a blanked row reads as ~0 ink. This is a
// RENDER test on purpose (KOTH b954fe3): a "fi" ligature in a gamertag silently dropped the whole
// mixed-font <text> row, invisible at the SVG-string level and only visible once resvg rasterizes
// it. buildCardSvg keeps every row single-font (KOTH b954fe3's fix) so this must still pass.
function rowInk(name: string): number {
  const svg = buildCardSvg({
    header: "TEST",
    title: "T",
    rows: [{ name, value: "9" }],
    displayFamily: "Animals are like people",
    gamertagFamily: "Patrick Hand",
  });
  const { pixels, width } = new Resvg(svg, {
    background: "#0a0b0d",
    fitTo: { mode: "width", value: 742 },
    font: {
      fontFiles: [ASSETS.fonts.display, ASSETS.fonts.gamertag],
      defaultFontFamily: "Animals are like people",
      loadSystemFonts: false,
    },
  }).render();
  let ink = 0;
  for (let y = 185; y <= 240; y++) {
    for (let x = 180; x <= 560; x++) {
      const i = (y * width + x) * 4;
      if (pixels[i]! > 40 || pixels[i + 1]! > 40 || pixels[i + 2]! > 40) ink++;
    }
  }
  return ink;
}

test("a gamertag containing an \"fi\" ligature still renders in a stat card row (not blanked by resvg)", () => {
  const control = rowInk("Zade zzzzy69"); // no ligature, same length: guards the band/threshold itself
  const ligature = rowInk("Fade fishy69"); // contains "fi": the row that vanished on the live E03 board
  expect(control).toBeGreaterThan(300); // control must render
  expect(ligature).toBeGreaterThan(300); // the fi-name must ALSO render: fails on the mixed-font bug (~0)
});
