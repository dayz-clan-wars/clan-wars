import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { StoryContext } from "../story/types.js";
import { ASSETS } from "../assets.js";
import { spawnRun, type Run } from "../engine/run.js";
import { buildCards, buildMarqueeItems, buildOutroBoard } from "../cards/cards.js";
import { rasterizePng, renderSegment } from "../engine/animation/compositor.js";
import { frameStates } from "../engine/animation/motion.js";
import { BORIS_RIG, PAVEL_RIG } from "../engine/animation/rigManifest.js";
import { buildScreenClip } from "../engine/animation/screenWall.js";
import { buildMarqueePng } from "../engine/animation/marquee.js";
import { readEpisodeVideoPath, writeEpisodeVideo } from "../engine/animation/episodeCache.js";
import { renderOutroBoardPng } from "../engine/video/outroBoard.js";
import { renderAnimatedShowVideo } from "../engine/video/renderShowVideo.js";
import type { VoicedEpisode } from "./voice.js";

// Replaces KOTH's `renderEpisodeVideo` (animated branch) + `renderEpisodeVideoCached`
// (bot/src/video/renderEpisode.js at a5ef8e7) and follows their order of operations. The cards,
// marquee items and outro board come from the StoryContext (src/cards) instead of KOTH's boards.

const FPS = 12; // animation internal fps (upsampled to 30 by renderAnimatedShowVideo)
const SEED = 7; // motion seed
const MARQUEE = { height: 90, speed: 120, y: 980, family: "Patrick Hand" };

/**
 * Structural resvg constructor that fits every engine module's own `ResvgCtor` (they differ in
 * which options they pass; the marquee also measures with `innerBBox`).
 */
export type AnyResvgCtor = new (svg: string, opts: any) => {
  render: () => { asPng: () => Buffer };
  innerBBox?: () => { x: number; width: number } | null;
};

/** The node:fs subset renderEpisode and everything it drives needs (real `fs` satisfies it). */
export type RenderFs = {
  existsSync: (p: string) => boolean;
  readFileSync: (p: string) => Buffer;
  writeFileSync: (p: string, d: Buffer) => void;
  mkdirSync: (p: string, o?: { recursive?: boolean }) => void;
  mkdtempSync: (prefix: string) => string;
  statSync: (p: string) => { size: number };
  copyFileSync: (src: string, dest: string) => void;
  readdirSync: (p: string) => string[];
  rmSync: (p: string, o?: { recursive?: boolean; force?: boolean }) => void;
  renameSync: (from: string, to: string) => void;
  linkSync: (existingPath: string, newPath: string) => void;
};

export type RenderDeps = {
  cacheDir: string;
  discordInvite: string;
  /** Every ffmpeg call goes through this. Defaults to `spawnRun`. */
  runImpl?: Run;
  ResvgImpl?: AnyResvgCtor;
  fsImpl?: RenderFs;
};

/**
 * Render the finished 1080p episode for a voiced episode. Returns the path of `video.mp4` under
 * `<cacheDir>/<key>/`; a second call for the same key returns it without rendering. Throws on any
 * failure (KOTH fell back to a static title card; that path is not ported, spec §11.2).
 */
export async function renderEpisode(deps: RenderDeps, ep: { voiced: VoicedEpisode; context: StoryContext }): Promise<string> {
  const { cacheDir, discordInvite, runImpl = spawnRun, ResvgImpl } = deps;
  const fsImpl: RenderFs = deps.fsImpl ?? fs;
  const { voiced, context } = ep;
  const { key } = voiced;

  const cached = readEpisodeVideoPath({ fsImpl }, { cacheDir, key });
  if (cached) return cached;

  const workDir = fsImpl.mkdtempSync(path.join(os.tmpdir(), "show-anim-"));
  try {
    const fonts = { displayFontPath: ASSETS.fonts.display, gamertagFontPath: ASSETS.fonts.gamertag };
    const rig = (p: string) => fsImpl.readFileSync(p).toString("utf8");

    // Outro board (season standings) over the outro screen.
    const boardPath = path.join(workDir, "board.png");
    fsImpl.writeFileSync(
      boardPath,
      renderOutroBoardPng({ board: buildOutroBoard(context), backgroundPath: ASSETS.outroScreen, ...fonts }, { fsImpl, ResvgImpl }),
    );

    // Static back (Background + Chairs) and front (Desk) layers.
    const backBg = path.join(workDir, "back_bg.png");
    const backChairs = path.join(workDir, "back_chairs.png");
    const backLayerPath = path.join(workDir, "back.png");
    const frontLayerPath = path.join(workDir, "front.png");
    fsImpl.writeFileSync(backBg, rasterizePng(rig(ASSETS.rigs.background), { ResvgImpl, transparent: false }));
    fsImpl.writeFileSync(backChairs, rasterizePng(rig(ASSETS.rigs.chairs), { ResvgImpl, transparent: true }));
    fsImpl.writeFileSync(frontLayerPath, rasterizePng(rig(ASSETS.rigs.deskNoChair), { ResvgImpl, transparent: true }));
    await runImpl("ffmpeg", ["-y", "-hide_banner", "-loglevel", "error", "-i", backBg, "-i", backChairs, "-filter_complex", "[0][1]overlay", backLayerPath]);

    // One dialogue clip spanning segA -> outro (single map, no sponsor break).
    const clipDur = voiced.outroSpan.startSec - voiced.segASpan.startSec;
    const screenOut = path.join(workDir, "screen_0.mp4");
    await buildScreenClip(
      { ResvgImpl, runImpl, fsImpl },
      { cards: buildCards(context), durSec: clipDur, fps: FPS, outPath: screenOut, workDir, ...fonts },
    );

    const marqueePng = path.join(workDir, "marquee.png");
    const { width: stripW } = buildMarqueePng(
      { ResvgImpl, fsImpl },
      {
        items: buildMarqueeItems(context, { discordInvite }),
        height: MARQUEE.height,
        family: MARQUEE.family,
        fontPath: ASSETS.fonts.gamertag,
        outPath: marqueePng,
      },
    );

    const boris = { svg: rig(ASSETS.rigs.boris), manifest: BORIS_RIG };
    const pavel = { svg: rig(ASSETS.rigs.pavel), manifest: PAVEL_RIG };
    const frames = frameStates({ turns: voiced.timeline, fps: FPS, totalSec: clipDur, seed: SEED });
    const segmentClip = path.join(workDir, "segment.mp4");
    await renderSegment(
      { ResvgImpl, ffmpegRun: runImpl, fsImpl },
      {
        boris,
        pavel,
        frames,
        fps: FPS,
        durSec: clipDur,
        backLayerPath,
        screenClipPath: screenOut,
        frontLayerPath,
        marqueePngPath: marqueePng,
        marqueeSpeed: MARQUEE.speed,
        stripW,
        stripH: MARQUEE.height,
        marqueeY: MARQUEE.y,
        outPath: segmentClip,
        workDir,
      },
    );

    const outPath = path.join(workDir, "video.mp4");
    await renderAnimatedShowVideo({
      audioPath: voiced.mp3Path,
      introScreenPath: ASSETS.introScreen,
      outroBoardPath: boardPath,
      segmentClipPath: segmentClip,
      segASpan: voiced.segASpan,
      outroSpan: voiced.outroSpan,
      totalSec: voiced.totalSec,
      outPath,
      runImpl,
    });
    // Not best-effort as in KOTH: the returned path is the cached copy, so the write must land.
    return writeEpisodeVideo({ fsImpl }, { cacheDir, key, videoPath: outPath });
  } finally {
    try {
      fsImpl.rmSync(workDir, { recursive: true, force: true });
    } catch {
      /* best-effort */
    }
  }
}
