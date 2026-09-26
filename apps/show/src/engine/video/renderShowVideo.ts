import { spawnRun, type Run } from "../run.js";

// Ported from KOTH bot/src/video/renderShowVideo.js at a5ef8e7, typed. Per the task-8 brief and
// global-context.md's "KOTH path" and "Span shapes" rulings: only `animatedVideoSegments` and
// `renderAnimatedShowVideo` are ported — the static title-card path (`videoSegments`,
// `renderShowVideo`, and every sponsor parameter) is dropped, per plan (spec §11.2).

const W = 1920;
const H = 1080;
const FPS = 30;
const XFADE = 1.0;
const FADEOUT = 3.0;

/**
 * A start+duration span, in seconds, on the video timeline (KOTH showNotifier.js:293 `spanOf`).
 * The audio side's `Span` (engine/audio/jingle.ts) is `{ startSec, endSec }`; this is a different
 * shape by design (global-context.md's "Span shapes" ruling) — never divide a `ClipSpan` by the
 * sample rate, and never treat the two as interchangeable.
 */
export type ClipSpan = { startSec: number; durSec: number };

export type AnimatedVideoSegment =
  | { kind: "still"; role: "intro" | "board"; durSec: number }
  | { kind: "clip"; role: "segment"; durSec: number; leadSec: number };

/**
 * Ordered visual segments for the single-map animated episode. Pure. Durations tile 0..totalSec.
 * KOTH's clip role was named `chernarus` (the map); this plan has no map name, so it is renamed
 * `segment` to match the `segmentClipPath` rename below (a smallest-reasonable-call rename, not a
 * behaviour change: the field is internal to this module and `renderAnimatedShowVideo`).
 */
export function animatedVideoSegments(o: { totalSec: number; segASpan: ClipSpan; outroSpan: ClipSpan }): AnimatedVideoSegment[] {
  const { segASpan, outroSpan } = o;
  return [
    { kind: "still", role: "intro", durSec: segASpan.startSec },
    { kind: "clip", role: "segment", durSec: outroSpan.startSec - segASpan.startSec, leadSec: 0 },
    { kind: "still", role: "board", durSec: outroSpan.durSec },
  ];
}

const PATH_ROLES = ["intro", "segment", "board"] as const;

/**
 * Render the single-map animated episode: intro still + segment clip + board still, concatenated
 * and muxed over audioPath. The board xfades in and the picture fades to black over the last
 * FADEOUT seconds. Clips are normalized to FPS/tb so a 12fps animated clip concats cleanly with
 * the stills. Both still branches scale to 1920x1080 regardless of the source image's own
 * resolution, which is what makes the 3840x2160 `intro-screen.png` (spec §11.1) render correctly
 * without a separate scaling step.
 *
 * Ported from KOTH `renderAnimatedShowVideo` (a5ef8e7): `leaderboardImagePath` -> `outroBoardPath`,
 * `chernarusClipPath` -> `segmentClipPath` (task-8 brief); `speed` is dropped and fixed at 1.0
 * (`DIALOGUE_SPEED` is not configurable, global-context.md); `runImpl` now takes the shared
 * `(cmd, args, opts?) => Promise<Buffer>` shape (engine/run.ts) instead of a bare `(args) => Promise<number>`,
 * matching every other ported engine file, and defaults to `spawnRun`.
 */
export async function renderAnimatedShowVideo(o: {
  audioPath: string;
  introScreenPath: string;
  outroBoardPath: string;
  segmentClipPath: string;
  segASpan: ClipSpan;
  outroSpan: ClipSpan;
  totalSec: number;
  outPath: string;
  runImpl?: Run;
}): Promise<string> {
  const { audioPath, introScreenPath, outroBoardPath, segmentClipPath, segASpan, outroSpan, totalSec, outPath, runImpl = spawnRun } = o;
  const segs = animatedVideoSegments({ totalSec, segASpan, outroSpan });
  const pathFor: Record<(typeof PATH_ROLES)[number], string> = {
    intro: introScreenPath,
    segment: segmentClipPath,
    board: outroBoardPath,
  };
  const xf = Math.min(XFADE, outroSpan.durSec, totalSec - outroSpan.durSec);

  const inputs: string[] = [];
  const chains: string[] = [];
  const labels: string[] = [];
  segs.forEach((seg, i) => {
    const src = pathFor[seg.role];
    if (seg.kind === "clip") {
      inputs.push("-i", src);
      chains.push(
        `[${i}:v]setpts=PTS/1.0,scale=${W}:${H},setsar=1,fps=${FPS},format=yuv420p,` +
          `tpad=stop_mode=clone:stop_duration=${seg.durSec},trim=duration=${seg.durSec},setpts=PTS-STARTPTS,settb=1/${FPS}[v${i}]`,
      );
    } else {
      const dur = seg.role === "board" ? seg.durSec + xf : seg.durSec;
      inputs.push("-loop", "1", "-t", String(dur), "-i", src);
      chains.push(`[${i}:v]scale=${W}:${H},setsar=1,fps=${FPS},format=yuv420p,setpts=PTS-STARTPTS,settb=1/${FPS}[v${i}]`);
    }
    labels.push(`[v${i}]`);
  });
  const audioIdx = segs.length;
  inputs.push("-i", audioPath);

  const parts = [...chains];
  const pre = labels.slice(0, -1);
  parts.push(`${pre.join("")}concat=n=${pre.length}:v=1:a=0,settb=1/${FPS}[pre]`);
  const offset = Math.max(0, totalSec - outroSpan.durSec - xf);
  parts.push(`[pre][v${segs.length - 1}]xfade=transition=fade:duration=${xf}:offset=${offset}[vx]`);
  let finalLabel = "[vx]";
  if (totalSec > FADEOUT) {
    parts.push(`${finalLabel}fade=t=out:st=${totalSec - FADEOUT}:d=${FADEOUT}[v]`);
    finalLabel = "[v]";
  }

  const args = [
    "-y",
    "-hide_banner",
    "-loglevel",
    "error",
    ...inputs,
    "-filter_complex",
    parts.join(";"),
    "-map",
    finalLabel,
    "-map",
    `${audioIdx}:a`,
    "-c:v",
    "libx264",
    "-pix_fmt",
    "yuv420p",
    "-r",
    String(FPS),
    "-c:a",
    "aac",
    "-b:a",
    "192k",
    "-shortest",
    outPath,
  ];
  await runImpl("ffmpeg", args);
  return outPath;
}
