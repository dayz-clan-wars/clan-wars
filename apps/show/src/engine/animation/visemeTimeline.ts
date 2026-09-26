import fs from "node:fs";
import path from "node:path";
import { spawnRun, type Run } from "../run.js";
import type { Span } from "../audio/jingle.js";
import { visemesForTurn, defaultRhubarbRun, type Cue, type RhubarbRun, type FsWriteLike } from "./visemes.js";

// Ported from KOTH bot/src/animation/visemeTimeline.js at a5ef8e7, typed. The private
// `defaultFfmpegRun` is dropped in favor of `Run`/`spawnRun` (`engine/run.ts`), the one
// child-process helper every ffmpeg/rhubarb call uses.

const SR = 24000;

/** One synthesized dialogue turn, as returned by `synthesizeElevenPcmTimed`. */
export type SynthesizedTurn = Span & { voiceId: string };

/** speaker-tagged, lip-synced turn on the final segment timeline, ready for `frameStates`. */
export type TimelineTurn = { speaker: "boris" | "pavel"; startSec: number; endSec: number; visemes: Cue[] };

/**
 * Per-turn Rhubarb lip-sync over a segment's PCM -> the timeline motion.frameStates consumes.
 * Slices each turn's audio out of segmentPcm by its [startSec,endSec), ffmpeg-converts it to a
 * WAV, runs Rhubarb, then shifts the returned cues to the turn's segment offset. DI'd runners.
 * `deps.rhubarbPath` is forwarded to the default Rhubarb runner (required unless `deps.runRhubarb`
 * is supplied directly) — the caller fills it from config (RenderConfig, Task 11); no env var.
 */
export async function buildSegmentTimeline(
  deps: { runRhubarb?: RhubarbRun; runFfmpeg?: Run; fsImpl?: FsWriteLike; rhubarbPath?: string } = {},
  o: { segmentPcm: Buffer; turns: SynthesizedTurn[]; borisVoiceId: string; sampleRate?: number; workDir: string },
): Promise<TimelineTurn[]> {
  const { runFfmpeg = spawnRun, fsImpl = fs, rhubarbPath } = deps;
  const runRhubarb: RhubarbRun =
    deps.runRhubarb ??
    (async (a) => {
      if (!rhubarbPath) {
        throw new Error("buildSegmentTimeline: rhubarbPath is required when runRhubarb is not provided");
      }
      return defaultRhubarbRun({ ...a, rhubarbPath, fsImpl, runImpl: spawnRun });
    });
  const { segmentPcm, turns, borisVoiceId, sampleRate = SR, workDir } = o;

  const timeline: TimelineTurn[] = [];
  for (let i = 0; i < turns.length; i++) {
    const t = turns[i]!;
    const startByte = Math.round(t.startSec * sampleRate * 2);
    const endByte = Math.round(t.endSec * sampleRate * 2);
    const pcm = segmentPcm.subarray(startByte, endByte);
    const pcmPath = path.join(workDir, `seg_turn_${i}.pcm`);
    const wavPath = path.join(workDir, `seg_turn_${i}.wav`);
    fsImpl.writeFileSync(pcmPath, pcm);
    await runFfmpeg("ffmpeg", [
      "-y",
      "-hide_banner",
      "-loglevel",
      "error",
      "-f",
      "s16le",
      "-ar",
      String(sampleRate),
      "-ac",
      "1",
      "-i",
      pcmPath,
      wavPath,
    ]);
    const cues = await visemesForTurn(runRhubarb, { audioPath: wavPath, dialogText: "" });
    timeline.push({
      speaker: t.voiceId === borisVoiceId ? "boris" : "pavel",
      startSec: t.startSec,
      endSec: t.endSec,
      visemes: cues.map((c) => ({ startSec: c.startSec + t.startSec, endSec: c.endSec + t.startSec, mouth: c.mouth })),
    });
  }
  return timeline;
}
