import { describe, it, expect } from "vitest";
import { buildSegmentComposeArgs, renderSegment, type ResvgCtor } from "../../../src/engine/animation/compositor.js";
import type { Run } from "../../../src/engine/run.js";
import type { RigManifest } from "../../../src/engine/animation/rigManifest.js";

describe("buildSegmentComposeArgs", () => {
  it("is silent and z-stacks screen->hosts->front->marquee", () => {
    const args = buildSegmentComposeArgs({
      backLayerPath: "/back.png",
      screenClipPath: "/screen.mp4",
      screenX: 588,
      screenY: 140,
      borisPattern: "/b_%04d.png",
      pavelPattern: "/p_%04d.png",
      frontLayerPath: "/front.png",
      marqueePngPath: "/m.png",
      marqueeSpeed: 120,
      stripW: 4000,
      stripH: 90,
      marqueeY: 980,
      fps: 12,
      durSec: 5,
      outPath: "/o.mp4",
    });
    const fc = args[args.indexOf("-filter_complex") + 1]!;
    // screen overlaid at 588,140 before hosts; marquee scroll uses a mod() x-expression.
    expect(fc).toContain("overlay=x=588:y=140");
    expect(fc).toContain("mod(");
    // silent: no -map to an audio stream, and -an present.
    expect(args).toContain("-an");
    expect(args).not.toContain("4:a");
    expect(args[args.length - 1]).toBe("/o.mp4");
  });

  it("works without screen/marquee (plain host composite)", () => {
    const args = buildSegmentComposeArgs({
      backLayerPath: "/back.png",
      borisPattern: "/b_%04d.png",
      pavelPattern: "/p_%04d.png",
      frontLayerPath: "/front.png",
      fps: 12,
      durSec: 5,
      outPath: "/o.mp4",
    });
    const fc = args[args.indexOf("-filter_complex") + 1]!;
    expect(fc).not.toContain("mod(");
    expect(args).toContain("-an");
  });
});

describe("renderSegment", () => {
  it("poses/dedups frames and runs one ffmpeg", async () => {
    const writes: string[] = [];
    const fsImpl = { writeFileSync: (p: string) => writes.push(p) };
    const ResvgImpl = class {
      render() {
        return { asPng: () => Buffer.from([1]) };
      }
    } as unknown as ResvgCtor;
    let ran: string[] | null = null;
    const ffmpegRun: Run = async (_cmd, args) => {
      ran = args;
      return Buffer.alloc(0);
    };
    const frame = {
      boris: { mouth: "Lip_X", eyes: "open", brows: "neutral", gaze: "center" },
      pavel: { mouth: "Lip_X", eyes: "open", brows: "neutral", gaze: "center" },
    };
    const rig: RigManifest = {
      mouths: ["Lip_X"],
      eyes: { open: [], closed: [] },
      pupils: [],
      eyeGeom: { halfWidth: 0, pupilRest: {} },
      brows: { neutral: [], raised: [], angry: [], thoughtful: [] },
    };
    const out = await renderSegment(
      { ResvgImpl, ffmpegRun, fsImpl },
      {
        boris: { svg: "<svg/>", manifest: rig },
        pavel: { svg: "<svg/>", manifest: rig },
        frames: [frame, frame],
        fps: 12,
        durSec: 2,
        backLayerPath: "/back.png",
        frontLayerPath: "/front.png",
        outPath: "/o.mp4",
        workDir: "/w",
      },
    );
    expect(out).toBe("/o.mp4");
    expect(writes.length).toBe(4); // 2 frames x 2 hosts
    expect(ran![ran!.length - 1]).toBe("/o.mp4");
  });
});
