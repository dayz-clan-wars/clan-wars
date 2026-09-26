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
  const rig: RigManifest = {
    mouths: ["Lip_X", "Lip_A"],
    eyes: { open: [], closed: [] },
    pupils: [],
    eyeGeom: { halfWidth: 0, pupilRest: {} },
    brows: { neutral: [], raised: [], angry: [], thoughtful: [] },
  };
  const pose = (mouth: string) => ({ mouth, eyes: "open", brows: "neutral", gaze: "center" });

  function harness(o: { linkFails?: boolean } = {}) {
    const writes: string[] = [];
    const links: [string, string][] = [];
    const copies: [string, string][] = [];
    const fsImpl = {
      writeFileSync: (p: string) => {
        writes.push(p);
      },
      linkSync: (existing: string, p: string) => {
        if (o.linkFails) throw new Error("EXDEV");
        links.push([existing, p]);
      },
      copyFileSync: (src: string, dest: string) => {
        copies.push([src, dest]);
      },
    };
    const ResvgImpl = class {
      render() {
        return { asPng: () => Buffer.from([1]) };
      }
    } as unknown as ResvgCtor;
    const ran: string[][] = [];
    const ffmpegRun: Run = async (_cmd, args) => {
      ran.push(args);
      return Buffer.alloc(0);
    };
    return { writes, links, copies, ran, deps: { ResvgImpl, ffmpegRun, fsImpl } };
  }

  const input = (frames: { boris: ReturnType<typeof pose>; pavel: ReturnType<typeof pose> }[]) => ({
    boris: { svg: "<svg/>", manifest: rig },
    pavel: { svg: "<svg/>", manifest: rig },
    frames,
    fps: 12,
    durSec: 2,
    backLayerPath: "/back.png",
    frontLayerPath: "/front.png",
    outPath: "/o.mp4",
    workDir: "/w",
  });

  it("writes each distinct pose PNG once and hard-links every frame name to it", async () => {
    const h = harness();
    const f1 = { boris: pose("Lip_X"), pavel: pose("Lip_X") };
    const f2 = { boris: pose("Lip_A"), pavel: pose("Lip_X") };
    const out = await renderSegment(h.deps, input([f1, f1, f2]));
    expect(out).toBe("/o.mp4");
    // 2 distinct boris poses + 1 distinct pavel pose, each written once.
    expect(h.writes).toHaveLength(3);
    expect(new Set(h.writes).size).toBe(3);
    for (const w of h.writes) expect(w).not.toMatch(/\/(boris|pavel)_\d{4}\.png$/);
    // Every frame name exists as a link to its pose file.
    const linked = h.links.map(([, p]) => p).sort();
    expect(linked).toEqual(
      ["/w/boris_0001.png", "/w/boris_0002.png", "/w/boris_0003.png", "/w/pavel_0001.png", "/w/pavel_0002.png", "/w/pavel_0003.png"],
    );
    const target = new Map(h.links.map(([e, p]) => [p, e]));
    expect(target.get("/w/boris_0001.png")).toBe(target.get("/w/boris_0002.png"));
    expect(target.get("/w/boris_0003.png")).not.toBe(target.get("/w/boris_0001.png"));
    expect(target.get("/w/pavel_0001.png")).toBe(target.get("/w/pavel_0003.png"));
    // The ffmpeg inputs are unchanged: the same frame patterns.
    expect(h.ran).toHaveLength(1);
    expect(h.ran[0]).toContain("/w/boris_%04d.png");
    expect(h.ran[0]).toContain("/w/pavel_%04d.png");
    expect(h.ran[0]![h.ran[0]!.length - 1]).toBe("/o.mp4");
  });

  it("falls back to a copy when a hard link fails", async () => {
    const h = harness({ linkFails: true });
    const f1 = { boris: pose("Lip_X"), pavel: pose("Lip_X") };
    await renderSegment(h.deps, input([f1, f1]));
    expect(h.writes).toHaveLength(2);
    expect(h.copies.map(([, d]) => d).sort()).toEqual(["/w/boris_0001.png", "/w/boris_0002.png", "/w/pavel_0001.png", "/w/pavel_0002.png"]);
  });
});
