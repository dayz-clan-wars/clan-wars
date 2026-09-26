import { describe, it, expect } from "vitest";
import { buildStripSvg, buildMarqueePng, type ResvgCtor } from "../../../src/engine/animation/marquee.js";

// Ported from KOTH bot/test/animation/marquee.test.js at a5ef8e7. `buildMarqueeItems` (and its
// COMMUNITY constant / default invite) is dropped per the task-7 brief, replaced by src/cards/ in a
// later task, so its test is dropped too.

describe("buildStripSvg", () => {
  it("renders the given text at the given width", () => {
    const { svg, width } = buildStripSvg({ text: "A ◆ BB", width: 500, height: 90, family: "Patrick Hand" });
    expect(svg).toContain("<svg");
    expect(svg).toContain("A");
    expect(svg).toContain('width="500"');
    expect(width).toBe(500);
  });

  it("XML-escapes text containing <, & and \"", () => {
    const { svg } = buildStripSvg({ text: 'A<b>&"c', width: 500, height: 90, family: "Patrick Hand" });
    expect(svg).toContain("A&lt;b&gt;&amp;&quot;c");
    expect(svg).not.toContain('A<b>&"c');
  });
});

describe("buildMarqueePng", () => {
  it("writes a png and returns width (estimate fallback when resvg cannot measure)", () => {
    let wrote: { p: string; len: number } | null = null;
    const fsImpl = {
      writeFileSync: (p: string, d: Buffer) => {
        wrote = { p, len: d.length };
      },
    };
    // fake resvg: no innerBBox -> measurePeriod returns null -> width comes from the estimate fallback
    const ResvgImpl = class {
      constructor(_svg: string, _opts: unknown) {}
      render() {
        return { asPng: () => Buffer.from([1, 2]) };
      }
    } as unknown as ResvgCtor;
    const { width, height } = buildMarqueePng(
      { ResvgImpl, fsImpl },
      { items: ["X"], height: 90, family: "Patrick Hand", fontPath: "/f.ttf", outPath: "/m.png" },
    );
    expect(wrote).not.toBeNull();
    expect(wrote!.p).toBe("/m.png");
    expect(width).toBeGreaterThan(0);
    expect(height).toBe(90);
  });
});
