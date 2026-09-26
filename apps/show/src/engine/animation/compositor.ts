import fs from "node:fs";
import path from "node:path";
import { Resvg } from "@resvg/resvg-js";
import { spawnRun, type Run } from "../run.js";
import { poseCharacter, type FramePose } from "./rig.js";
import type { RigManifest } from "./rigManifest.js";

// Ported from KOTH bot/src/animation/compositor.js at a5ef8e7, typed. Dropped per the task-6 brief:
// `buildComposeArgs` and `renderPoc` (the proof-of-concept path; nothing in the pipeline calls
// them). The private `defaultFfmpegRun` is dropped in favor of `Run`/`spawnRun` (`engine/run.ts`).

const W = 1920;

export type ResvgCtor = new (
  svg: string,
  opts: { fitTo: { mode: "width"; value: number }; background: string },
) => { render: () => { asPng: () => Buffer } };

/** SVG string -> PNG buffer at 1920 wide (transparent for characters). */
export function rasterizePng(svgText: string, o: { ResvgImpl?: ResvgCtor; transparent?: boolean } = {}): Buffer {
  const { ResvgImpl = Resvg as unknown as ResvgCtor, transparent = true } = o;
  const r = new ResvgImpl(svgText, {
    fitTo: { mode: "width", value: W },
    background: transparent ? "rgba(0,0,0,0)" : "#000000",
  });
  return r.render().asPng();
}

export const poseKey = (s: FramePose): string => `${s.mouth}|${s.eyes}|${s.brows}|${s.gaze}`;

/**
 * Pure: the single ffmpeg invocation for a SILENT animated segment clip. Z-stack:
 *   back -> [screen clip @screenX,screenY] -> boris -> pavel -> front -> [marquee strip scrolling].
 * Screen and marquee inputs are optional. Idle bob is applied to the host overlays (as in the POC).
 * The marquee is a SEAMLESS ticker: the strip PNG (width `stripW` = one padded cycle >= frame width)
 * is split into two copies scrolling left in lockstep at `marqueeSpeed`, the second placed exactly
 * one period (`stripW`) to the right of the first (x = `stripW - mod(t*speed, stripW)`). As one copy
 * exits left the identical copy behind it is already covering the frame, so there is no gap and it
 * never blanks — it loops forever. Sits at y=marqueeY.
 */
export function buildSegmentComposeArgs(o: {
  backLayerPath: string;
  screenClipPath?: string;
  screenX?: number;
  screenY?: number;
  borisPattern: string;
  pavelPattern: string;
  frontLayerPath: string;
  marqueePngPath?: string;
  marqueeSpeed?: number;
  stripW?: number;
  stripH?: number;
  marqueeY?: number;
  fps: number;
  durSec: number;
  outPath: string;
  idleAmp?: number;
  idlePeriod?: number;
}): string[] {
  const {
    backLayerPath,
    screenClipPath,
    screenX = 588,
    screenY = 140,
    borisPattern,
    pavelPattern,
    frontLayerPath,
    marqueePngPath,
    marqueeSpeed = 120,
    stripW = 0,
    marqueeY = 980,
    fps,
    durSec,
    outPath,
    idleAmp = 4,
    idlePeriod = 4,
  } = o;
  const bob = (phase: string) => `${idleAmp}*sin(2*PI*t/${idlePeriod}${phase})`;
  const inputs: string[] = ["-loop", "1", "-i", backLayerPath];
  let idx = 1;
  let base = "[0]";
  const fc: string[] = [];

  if (screenClipPath) {
    inputs.push("-i", screenClipPath);
    const s = idx++;
    fc.push(`${base}[${s}]overlay=x=${screenX}:y=${screenY}[bs]`);
    base = "[bs]";
  }
  inputs.push("-framerate", String(fps), "-i", borisPattern);
  const bi = idx++;
  inputs.push("-framerate", String(fps), "-i", pavelPattern);
  const pi = idx++;
  inputs.push("-loop", "1", "-i", frontLayerPath);
  const fi = idx++;

  fc.push(`${base}[${bi}]overlay=x=0:y='${bob("")}'[a]`);
  fc.push(`[a][${pi}]overlay=x=0:y='${bob("+PI")}'[b]`);
  fc.push(`[b][${fi}]overlay${marqueePngPath ? "[d]" : "[c]"}`);

  if (marqueePngPath) {
    inputs.push("-i", marqueePngPath);
    const mi = idx++;
    // Two identical copies spaced one period (stripW) apart, both scrolling left -> seamless loop.
    fc.push(`[${mi}]split=2[mA][mB]`);
    fc.push(`[d][mA]overlay=x='-mod(t*${marqueeSpeed}\\,${stripW})':y=${marqueeY}[e]`);
    fc.push(`[e][mB]overlay=x='${stripW}-mod(t*${marqueeSpeed}\\,${stripW})':y=${marqueeY}[c]`);
  }

  return [
    "-y",
    "-hide_banner",
    "-loglevel",
    "error",
    ...inputs,
    "-filter_complex",
    fc.join(";"),
    "-map",
    "[c]",
    "-an",
    "-c:v",
    "libx264",
    "-pix_fmt",
    "yuv420p",
    "-r",
    String(fps),
    "-t",
    String(durSec),
    outPath,
  ];
}

export type CharacterRig = { svg: string; manifest: RigManifest };

/** Render one silent animated segment: dedup poses -> per-frame PNG sequences -> one ffmpeg composite. */
export type WriteFileFsLike = { writeFileSync: (p: string, data: Buffer) => void };

export async function renderSegment(
  deps: { ResvgImpl?: ResvgCtor; ffmpegRun?: Run; fsImpl?: WriteFileFsLike } = {},
  o: {
    boris: CharacterRig;
    pavel: CharacterRig;
    frames: { boris: FramePose; pavel: FramePose }[];
    fps: number;
    durSec: number;
    backLayerPath: string;
    screenClipPath?: string;
    screenX?: number;
    screenY?: number;
    frontLayerPath: string;
    marqueePngPath?: string;
    marqueeSpeed?: number;
    stripW?: number;
    stripH?: number;
    marqueeY?: number;
    outPath: string;
    workDir: string;
    idleAmp?: number;
    idlePeriod?: number;
  },
): Promise<string> {
  const { ResvgImpl, ffmpegRun = spawnRun, fsImpl = fs } = deps;
  const {
    boris,
    pavel,
    frames,
    fps,
    durSec,
    backLayerPath,
    screenClipPath,
    screenX,
    screenY,
    frontLayerPath,
    marqueePngPath,
    marqueeSpeed,
    stripW,
    stripH,
    marqueeY,
    outPath,
    workDir,
    idleAmp = 4,
    idlePeriod = 4,
  } = o;

  const cache = new Map<string, Buffer>();
  const rasterFor = (who: "boris" | "pavel", char: CharacterRig, state: FramePose): Buffer => {
    const key = `${who}:${poseKey(state)}`;
    let png = cache.get(key);
    if (!png) {
      const svg = poseCharacter(char.svg, char.manifest, state);
      png = rasterizePng(svg, { ResvgImpl, transparent: true });
      cache.set(key, png);
    }
    return png;
  };
  const pad = (i: number) => String(i + 1).padStart(4, "0");
  frames.forEach((fr, i) => {
    fsImpl.writeFileSync(path.join(workDir, `boris_${pad(i)}.png`), rasterFor("boris", boris, fr.boris));
    fsImpl.writeFileSync(path.join(workDir, `pavel_${pad(i)}.png`), rasterFor("pavel", pavel, fr.pavel));
  });
  const args = buildSegmentComposeArgs({
    backLayerPath,
    screenClipPath,
    screenX,
    screenY,
    borisPattern: path.join(workDir, "boris_%04d.png"),
    pavelPattern: path.join(workDir, "pavel_%04d.png"),
    frontLayerPath,
    marqueePngPath,
    marqueeSpeed,
    stripW,
    stripH,
    marqueeY,
    fps,
    durSec,
    outPath,
    idleAmp,
    idlePeriod,
  });
  await ffmpegRun("ffmpeg", args);
  return outPath;
}
