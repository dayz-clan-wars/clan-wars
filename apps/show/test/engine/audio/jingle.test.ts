import { describe, it, expect } from "vitest";
import {
  assembleEpisodePcm,
  assembleShowEpisode,
  decodeClipPcm,
  clipCacheKey,
  jingleCachePath,
  cachedPcm,
  overlapPcm,
  speedUpPcm,
  type FsLike,
} from "../../../src/engine/audio/jingle.js";
import type { Run } from "../../../src/engine/run.js";

const SAMPLE_RATE = 24000;
const pcmOf = (bytes: number[]) => Buffer.from(bytes);

describe("speedUpPcm", () => {
  it("resamples via asetrate (pitch rises with speed) by the factor, piping the pcm through", async () => {
    const seen: { args?: string; input?: Buffer; cmd?: string } = {};
    const runImpl: Run = async (cmd, args, opts) => {
      seen.cmd = cmd;
      seen.args = args.join(" ");
      seen.input = opts?.input;
      return Buffer.from([9, 9]);
    };
    const pcm = Buffer.from([5, 0, 6, 0]);
    const out = await speedUpPcm({ pcm, factor: 1.2, runImpl });
    expect([...out]).toEqual([9, 9]);
    expect(seen.cmd).toBe("ffmpeg");
    expect(seen.args).toContain("asetrate=28800"); // 24000 * 1.2 -> faster + higher pitch
    expect(seen.args).toContain("aresample=24000"); // back to the pipeline rate
    expect(seen.args).toContain("pipe:0");
    expect(seen.input).toBe(pcm); // pcm fed via stdin
  });

  it("factor 1 or empty pcm is a no-op (no ffmpeg call)", async () => {
    let called = false;
    const runImpl: Run = async () => {
      called = true;
      return Buffer.alloc(0);
    };
    const pcm = Buffer.from([1, 2, 3, 4]);
    expect(await speedUpPcm({ pcm, factor: 1, runImpl })).toBe(pcm);
    expect((await speedUpPcm({ pcm: Buffer.alloc(0), factor: 1.2, runImpl })).length).toBe(0);
    expect(called).toBe(false);
  });
});

describe("assembleEpisodePcm", () => {
  it("intro + dialogue + outro joined with non-empty gaps", () => {
    const out = assembleEpisodePcm({ introPcm: pcmOf([1, 1]), dialoguePcm: pcmOf([2, 2]), outroPcm: pcmOf([3, 3]) });
    expect(out.length).toBeGreaterThan(6); // intro + gap + dialogue + gap + outro
    expect(out[0]).toBe(1);
    expect(out[out.length - 1]).toBe(3);
  });

  it("null intro/outro are skipped; dialogue-only has no gaps", () => {
    const out = assembleEpisodePcm({ introPcm: null, dialoguePcm: pcmOf([2, 2, 2, 2]), outroPcm: null });
    expect([...out]).toEqual([2, 2, 2, 2]);
  });

  it("empty buffers treated as missing", () => {
    const out = assembleEpisodePcm({ introPcm: Buffer.alloc(0), dialoguePcm: pcmOf([2, 2]), outroPcm: Buffer.alloc(0) });
    expect([...out]).toEqual([2, 2]);
  });
});

describe("decodeClipPcm", () => {
  it("decodes a whole finished clip to 24k mono pcm, as-is (no trim/fade/volume); returns pcm", async () => {
    const seen: { args?: string[]; cmd?: string } = {};
    const runImpl: Run = async (cmd, args) => {
      seen.cmd = cmd;
      seen.args = args;
      return Buffer.from([9, 9, 9]);
    };
    const pcm = await decodeClipPcm({ clipPath: "/tmp/outro.wav", runImpl });
    expect([...pcm]).toEqual([9, 9, 9]);
    expect(seen.cmd).toBe("ffmpeg");
    const a = (seen.args as string[]).join(" ");
    expect(a).toContain("-i /tmp/outro.wav");
    expect(a).toContain("aresample=24000");
    expect(a).toContain("s16le");
    // as-is: no trimming, fading, seeking, or volume change
    expect(a).not.toContain("-ss");
    expect(a).not.toContain("-t ");
    expect(a).not.toContain("afade");
    expect(a).not.toContain("volume=");
  });

  it("throws when ffmpeg yields empty pcm", async () => {
    const runImpl: Run = async () => Buffer.alloc(0);
    await expect(decodeClipPcm({ clipPath: "/tmp/o.wav", runImpl })).rejects.toThrow(/no pcm/);
  });
});

function memFs(initial: Record<string, Buffer> = {}): FsLike {
  const files = new Map(Object.entries(initial));
  return {
    existsSync: (p) => files.has(p),
    readFileSync: (p) => files.get(p) as Buffer,
    writeFileSync: (p, b) => {
      files.set(p, Buffer.from(b));
    },
    mkdirSync: () => undefined,
  };
}

describe("clipCacheKey", () => {
  it("stable for the same file, differs when the file identity changes", () => {
    const a = clipCacheKey({ clipStat: { size: 200, mtimeMs: 1700000000000 } });
    const b = clipCacheKey({ clipStat: { size: 200, mtimeMs: 1700000000000 } });
    const c = clipCacheKey({ clipStat: { size: 201, mtimeMs: 1700000000000 } });
    expect(a).toBe(b);
    expect(a).not.toBe(c);
  });
});

describe("jingleCachePath", () => {
  it("one path under the cache dir, embedding the key + kind", () => {
    expect(jingleCachePath({ cacheDir: "/c", key: "abc123", kind: "intro" })).toBe("/c/jingle-abc123.intro.pcm");
    expect(jingleCachePath({ cacheDir: "/c", key: "def456", kind: "outro" })).toBe("/c/jingle-def456.outro.pcm");
  });
});

describe("cachedPcm", () => {
  it("cache miss builds + persists; cache hit reuses without rebuilding", async () => {
    const fsImpl = memFs();
    let builds = 0;
    const build = async () => {
      builds++;
      return Buffer.from([1, 2, 3]);
    };
    const first = await cachedPcm({ file: "/c/x.pcm", build, fsImpl });
    expect([...first]).toEqual([1, 2, 3]);
    expect(builds).toBe(1);
    expect(fsImpl.existsSync("/c/x.pcm")).toBe(true);

    const second = await cachedPcm({ file: "/c/x.pcm", build, fsImpl });
    expect([...second]).toEqual([1, 2, 3]);
    expect(builds).toBe(1); // not rebuilt
  });
});

describe("assembleShowEpisode", () => {
  const b = (n: number) => Buffer.from([n, n]);

  it("orders intro,segA,outro with gaps, skipping empties", () => {
    const { pcm: out } = assembleShowEpisode({ introPcm: b(1), segAPcm: b(2), outroPcm: b(6) });
    expect(out[0]).toBe(1);
    expect(out[out.length - 1]).toBe(6);
    const order = [1, 2, 6].map((n) => out.indexOf(n));
    expect(order).toEqual([...order].sort((a, z) => a - z));
  });

  it("marks has intro/segA/outro only, no sponsor/segB", () => {
    const { marks } = assembleShowEpisode({ introPcm: b(1), segAPcm: b(2), outroPcm: b(6) });
    expect(Object.keys(marks).sort()).toEqual(["intro", "outro", "segA"]);
    expect((marks as Record<string, unknown>).sponsor).toBeUndefined();
    expect((marks as Record<string, unknown>).segB).toBeUndefined();
  });

  it("empty segA collapses cleanly (intro then gap then outro)", () => {
    const { pcm: out, marks } = assembleShowEpisode({ introPcm: b(1), segAPcm: Buffer.alloc(0), outroPcm: b(6) });
    expect([...out]).toContain(1);
    expect([...out]).toContain(6);
    expect(marks.segA).toBeUndefined();
    expect(marks.outro!.startSec).toBeGreaterThan(marks.intro!.endSec);
  });

  it("marks give each present segment span (outro offset accounts for the gap)", () => {
    const b2 = (n: number, len = 4) => Buffer.alloc(len, n); // 4 bytes = 2 samples each
    const { pcm, marks } = assembleShowEpisode({ introPcm: b2(1), segAPcm: b2(2), outroPcm: b2(5) });
    // No overlaps here: every seam is a SEGMENT_GAP.
    const gapSec = marks.segA!.startSec - marks.intro!.endSec; // one gap, in seconds
    expect(gapSec).toBeGreaterThan(0);
    expect(marks.intro).toEqual({ startSec: 0, endSec: 2 / SAMPLE_RATE });
    // outro span length equals its source pcm (2 samples)
    expect(marks.outro!.endSec - marks.outro!.startSec).toBeCloseTo(2 / SAMPLE_RATE, 9);
    // outro starts after intro(2) + gap + segA(2) + gap
    expect(marks.outro!.startSec).toBeCloseTo(2 / SAMPLE_RATE + gapSec + 2 / SAMPLE_RATE + gapSec, 9);
    // total seconds = pcm bytes / 2 / sampleRate
    expect(pcm.length / 2 / SAMPLE_RATE).toBeCloseTo(marks.outro!.endSec, 9);
  });

  it("outroOverlapMs: 0 makes segA->outro a plain gap", () => {
    const b2 = (n: number, len = 4) => Buffer.alloc(len, n);
    const { marks } = assembleShowEpisode({ introPcm: b2(1), segAPcm: b2(2), outroPcm: b2(5) }, { outroOverlapMs: 0 });
    const gapSec = marks.segA!.startSec - marks.intro!.endSec;
    expect(marks.outro!.startSec).toBeCloseTo(marks.segA!.endSec + gapSec, 9);
  });

  it("marks are correct on the overlap seam (introOverlapMs > 0)", () => {
    const SR = 24000;
    const overlapMs = 100; // 0.1s => Math.floor(0.1 * 24000) = 2400 samples exactly
    const overlapSamples = Math.floor((overlapMs / 1000) * SR);
    // Buffers are 4x the overlap so the clamp never triggers (min is well-bounded)
    const overlapBytes = overlapSamples * 2; // 4800 bytes
    const introPcm = Buffer.alloc(overlapBytes * 4, 1); // 19200 bytes = 9600 samples
    const segAPcm = Buffer.alloc(overlapBytes * 4, 2);
    const outroPcm = Buffer.alloc(400, 3); // 200 samples

    const { marks } = assembleShowEpisode({ introPcm, segAPcm, outroPcm }, { introOverlapMs: overlapMs });

    // segA.startSec is non-negative
    expect(marks.segA!.startSec).toBeGreaterThanOrEqual(0);
    // segA starts INSIDE the intro: the overlap in seconds is intro.endSec - segA.startSec
    expect(marks.intro!.endSec - marks.segA!.startSec).toBeCloseTo(overlapSamples / SR, 9);
    // Subsequent segments still follow segA
    expect(marks.outro!.startSec).toBeGreaterThan(marks.segA!.endSec);
  });

  it("marks are correct on the outro overlap seam (outroOverlapMs > 0, segA->outro)", () => {
    const SR = 24000;
    const overlapMs = 100;
    const overlapSamples = Math.floor((overlapMs / 1000) * SR);
    const overlapBytes = overlapSamples * 2;
    const segAPcm = Buffer.alloc(overlapBytes * 4, 2);
    const outroPcm = Buffer.alloc(overlapBytes * 4, 3);

    const { marks } = assembleShowEpisode({ segAPcm, outroPcm }, { outroOverlapMs: overlapMs });

    // outro starts INSIDE segA: the overlap in seconds is segA.endSec - outro.startSec
    expect(marks.segA!.endSec - marks.outro!.startSec).toBeCloseTo(overlapSamples / SR, 9);
  });
});

const pcmSamples = (val: number, n: number) => {
  const b = Buffer.alloc(n * 2);
  for (let i = 0; i < n; i++) b.writeInt16LE(val, i * 2);
  return b;
};

describe("overlapPcm", () => {
  it("full overlap of equal clips: length = a+b-overlap, region is the SUM", () => {
    const a = pcmSamples(1000, 4);
    const bb = pcmSamples(2000, 4);
    const out = overlapPcm(a, bb, 1000); // huge overlapMs clamps to 4 samples
    expect(out.length).toBe(8); // 8 + 8 - 8
    for (let i = 0; i < out.length; i += 2) expect(out.readInt16LE(i)).toBe(3000); // a+b
  });

  it("overlap clamps to the shorter clip", () => {
    const a = pcmSamples(1000, 4);
    const bb = pcmSamples(2000, 10);
    const out = overlapPcm(a, bb, 1000);
    expect(out.length).toBe(8 + 20 - 8); // 20
  });

  it("summed peaks are int16-clamped", () => {
    const a = pcmSamples(20000, 4);
    const bb = pcmSamples(20000, 4);
    const out = overlapPcm(a, bb, 1000); // 40000 -> clamp 32767
    for (let i = 0; i < out.length; i += 2) expect(out.readInt16LE(i)).toBe(32767);
  });

  it("overlapMs rounding to 0 samples -> plain concat", () => {
    const a = pcmSamples(1000, 4);
    const bb = pcmSamples(2000, 4);
    const out = overlapPcm(a, bb, 0);
    expect([...out]).toEqual([...Buffer.concat([a, bb])]);
  });
});

describe("assembleShowEpisode overlap", () => {
  it("intro->segA overlap sums the region (not a silent gap)", () => {
    const parts = { introPcm: pcmSamples(1000, 100), segAPcm: pcmSamples(2000, 100) };
    const { pcm: out } = assembleShowEpisode(parts, { introOverlapMs: 1 });
    let summed = false;
    for (let i = 0; i + 1 < out.length; i += 2) {
      if (out.readInt16LE(i) === 3000) {
        summed = true;
        break;
      }
    }
    expect(summed).toBe(true); // overlap region holds a+b = 3000
  });

  it("overlap opts shorten the episode vs the all-gap join", () => {
    const parts = { introPcm: pcmSamples(1, 100), segAPcm: pcmSamples(2, 100), outroPcm: pcmSamples(6, 100) };
    const { pcm: gapped } = assembleShowEpisode(parts);
    const { pcm: overlapped } = assembleShowEpisode(parts, { introOverlapMs: 1, outroOverlapMs: 1 });
    expect(overlapped.length).toBeLessThan(gapped.length);
  });

  it("overlap 0 (default opts) is byte-identical to the gap join", () => {
    const parts = { introPcm: pcmSamples(1, 50), segAPcm: pcmSamples(2, 50), outroPcm: pcmSamples(6, 50) };
    expect([...assembleShowEpisode(parts, {}).pcm]).toEqual([...assembleShowEpisode(parts).pcm]);
  });

  it("missing intro -> no front overlap, still assembles", () => {
    const parts = { segAPcm: pcmSamples(2, 50), outroPcm: pcmSamples(6, 50) };
    const { pcm: out } = assembleShowEpisode(parts, { introOverlapMs: 1, outroOverlapMs: 1 });
    expect(out.length).toBeGreaterThan(0);
  });
});
