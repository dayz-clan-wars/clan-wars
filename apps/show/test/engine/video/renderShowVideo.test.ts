import { describe, it, expect, test } from "vitest";
import { animatedVideoSegments, renderAnimatedShowVideo, type ClipSpan } from "../../../src/engine/video/renderShowVideo.js";
import type { Run } from "../../../src/engine/run.js";

// Ported from KOTH bot/test/video/renderAnimatedShowVideo.test.js at a5ef8e7, typed. Every
// videoSegments/renderShowVideo (static title-card path) test from renderShowVideo.test.js is
// dropped per the task-8 brief — this plan never ports that path. Reshaped: KOTH's runImpl took
// only `args` and returned a number; this repo's `Run` (engine/run.ts) is `(cmd, args, opts?) =>
// Promise<Buffer>`, matching every other ported engine file. `leaderboardImagePath` ->
// `outroBoardPath`, `chernarusClipPath` -> `segmentClipPath`, `speed` dropped (fixed at 1.0).

const spans: { totalSec: number; segASpan: ClipSpan; outroSpan: ClipSpan } = {
  totalSec: 100,
  segASpan: { startSec: 5, durSec: 30 }, // segment content 5..35
  outroSpan: { startSec: 80, durSec: 20 }, // board 80..100
};

describe("animatedVideoSegments", () => {
  it("orders intro/segment/board with correct durations (single map, no sponsor)", () => {
    const segs = animatedVideoSegments(spans);
    expect(segs.map((s) => s.role)).toEqual(["intro", "segment", "board"]);
    expect(segs[0]!.kind).toBe("still");
    expect(segs[0]!.durSec).toBeCloseTo(5, 3); // intro still 0..5
    expect(segs[1]!.kind).toBe("clip");
    expect(segs[1]!.durSec).toBeCloseTo(75, 3); // segment 5..80 (outro start - segA start)
    expect((segs[1] as { leadSec: number }).leadSec).toBeCloseTo(0, 3);
    expect(segs[2]!.kind).toBe("still");
    expect(segs[2]!.durSec).toBeCloseTo(20, 3); // board 80..100
    // durations tile 0..totalSec
    const total = segs.reduce((a, s) => a + s.durSec, 0);
    expect(total).toBeCloseTo(spans.totalSec, 3);
  });
});

describe("renderAnimatedShowVideo", () => {
  test("maps intro/segment/board to input paths and muxes over audio", async () => {
    let ran: string[] | null = null;
    const runImpl: Run = async (_cmd, args) => {
      ran = args;
      return Buffer.alloc(0);
    };
    await renderAnimatedShowVideo({
      audioPath: "/a.mp3",
      introScreenPath: "/intro.png",
      outroBoardPath: "/board.png",
      segmentClipPath: "/seg.mp4",
      ...spans,
      outPath: "/o.mp4",
      runImpl,
    });
    const joined = ran!.join(" ");
    expect(joined).toContain("/intro.png");
    expect(joined).toContain("/seg.mp4");
    expect(joined).toContain("/board.png");
    expect(joined).toContain("/a.mp3");
    // no sponsor / livonia inputs anymore
    expect(joined).not.toContain("/ad.mp4");
    expect(joined).not.toContain("/liv.mp4");
    // ends with an xfade into the board then a fade-to-black, mapped to output
    expect(joined).toContain("xfade=transition=fade");
    expect(joined).toContain("fade=t=out");
    expect(ran![ran!.length - 1]).toBe("/o.mp4");
  });

  it("scales the intro still to 1920x1080 (intro-screen.png is 3840x2160)", async () => {
    let ran: string[] | null = null;
    const runImpl: Run = async (_cmd, args) => {
      ran = args;
      return Buffer.alloc(0);
    };
    await renderAnimatedShowVideo({
      audioPath: "/a.mp3",
      introScreenPath: "/intro.png",
      outroBoardPath: "/board.png",
      segmentClipPath: "/seg.mp4",
      ...spans,
      outPath: "/o.mp4",
      runImpl,
    });
    expect(ran!.join(" ")).toContain("scale=1920:1080");
  });
});
