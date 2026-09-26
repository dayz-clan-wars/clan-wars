import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { spawnRun, type Run } from "../run.js";
import { writeFileAtomic, type AtomicFsLike } from "../atomicWrite.js";

const SAMPLE_RATE = 24000;

// ~0.4s of s16le silence between segments (longer than the 0.1s intra-dialogue gap).
const SEGMENT_GAP = Buffer.alloc(Math.round(2 * SAMPLE_RATE * 0.4));

const BYTES_PER_SAMPLE = 2;

/** A time span, in seconds, within an assembled PCM buffer. Later tasks import this from here. */
export type Span = { startSec: number; endSec: number };

/**
 * Overlap-add: overlap the tail of `a` with the head of `b` by `overlapMs` by SUMMING the two
 * regions sample-by-sample (`out = a + b`), int16-clamped (two full-level clips can sum past full
 * scale). No fade — both clips play at full level across the overlap. The overlap is sample-aligned
 * and clamped to the shorter clip; an `overlapMs` that rounds to 0 samples yields a plain concat.
 */
export function overlapPcm(a: Buffer, b: Buffer, overlapMs: number, sampleRate: number = SAMPLE_RATE): Buffer {
  const want = Math.floor((overlapMs / 1000) * sampleRate) * BYTES_PER_SAMPLE;
  const overlap = Math.min(want, a.length, b.length);
  if (overlap <= 0) return Buffer.concat([a, b]);
  const head = a.subarray(0, a.length - overlap);
  const tail = b.subarray(overlap);
  const mix = Buffer.alloc(overlap);
  const n = overlap / BYTES_PER_SAMPLE;
  for (let i = 0; i < n; i++) {
    const av = a.readInt16LE(a.length - overlap + i * BYTES_PER_SAMPLE);
    const bv = b.readInt16LE(i * BYTES_PER_SAMPLE);
    let v = av + bv;
    if (v > 32767) v = 32767;
    else if (v < -32768) v = -32768;
    mix.writeInt16LE(v, i * BYTES_PER_SAMPLE);
  }
  return Buffer.concat([head, mix, tail]);
}

/** Concatenate intro ++ dialogue ++ outro with a gap around each present segment. Skips empty/missing. */
export function assembleEpisodePcm(o: { introPcm?: Buffer | null; dialoguePcm?: Buffer | null; outroPcm?: Buffer | null }): Buffer {
  const { introPcm, dialoguePcm, outroPcm } = o;
  const parts: Buffer[] = [];
  if (introPcm?.length) parts.push(introPcm, SEGMENT_GAP);
  if (dialoguePcm?.length) parts.push(dialoguePcm);
  if (outroPcm?.length) parts.push(SEGMENT_GAP, outroPcm);
  return Buffer.concat(parts);
}

/**
 * Concatenate the single-map episode: intro ++ segA(dialogue) ++ outro. By default every present
 * part is joined with SEGMENT_GAP. With `introOverlapMs`/`outroOverlapMs` > 0, the intro→segA and
 * segA→outro seams OVERLAP instead (via overlapPcm — both clips play, summed). A missing part
 * collapses cleanly. Marks are reported in seconds (`Span`), not samples — the rest of the pipeline
 * (ElevenLabs turn spans, the viseme timeline) already works in seconds.
 */
export function assembleShowEpisode(
  parts: { introPcm?: Buffer | null; segAPcm?: Buffer | null; outroPcm?: Buffer | null },
  o: { introOverlapMs?: number; outroOverlapMs?: number; sampleRate?: number } = {},
): { pcm: Buffer; marks: { intro?: Span; segA?: Span; outro?: Span } } {
  const { introPcm, segAPcm, outroPcm } = parts;
  const { introOverlapMs = 0, outroOverlapMs = 0, sampleRate = SAMPLE_RATE } = o;
  const seq = ([["intro", introPcm] as const, ["segA", segAPcm] as const, ["outro", outroPcm] as const]).filter(
    ([, pcm]) => pcm?.length,
  ) as [string, Buffer][];

  const marks: { intro?: Span; segA?: Span; outro?: Span } = {};
  const mark = (name: string, startByte: number, len: number) => {
    (marks as Record<string, Span>)[name] = {
      startSec: startByte / (BYTES_PER_SAMPLE * sampleRate),
      endSec: (startByte + len) / (BYTES_PER_SAMPLE * sampleRate),
    };
  };
  if (!seq.length) return { pcm: Buffer.alloc(0), marks };

  let out = seq[0]![1];
  let prev = seq[0]![0];
  mark(prev, 0, out.length);
  for (let i = 1; i < seq.length; i++) {
    const [name, pcm] = seq[i]!;
    let startByte: number;
    const overlapMs = prev === "intro" && name === "segA" ? introOverlapMs : prev === "segA" && name === "outro" ? outroOverlapMs : 0;
    if (overlapMs > 0) {
      const overlap = Math.min(Math.floor((overlapMs / 1000) * sampleRate) * BYTES_PER_SAMPLE, out.length, pcm.length);
      startByte = out.length - overlap;
      out = overlapPcm(out, pcm, overlapMs, sampleRate);
    } else {
      startByte = out.length + SEGMENT_GAP.length;
      out = Buffer.concat([out, SEGMENT_GAP, pcm]);
    }
    mark(name, startByte, pcm.length);
    prev = name;
  }
  return { pcm: out, marks };
}

/**
 * Decode a whole finished audio file to s16le/24k/mono PCM, AS-IS — no trim, fade, seek,
 * or volume change. The production lives in the operator's clip; this only format-normalizes
 * it so it concatenates and rides the single final loudnorm. Used for the intro and outro.
 * `runImpl` defaults to `spawnRun` (the one child-process helper every ffmpeg/rhubarb call uses).
 */
export async function decodeClipPcm(o: { clipPath: string; runImpl?: Run }): Promise<Buffer> {
  const { clipPath, runImpl = spawnRun } = o;
  const args = [
    "-hide_banner",
    "-loglevel",
    "error",
    "-i",
    clipPath,
    "-af",
    `aresample=${SAMPLE_RATE},aformat=channel_layouts=mono`,
    "-ac",
    "1",
    "-f",
    "s16le",
    "pipe:1",
  ];
  const pcm = await runImpl("ffmpeg", args);
  if (!pcm || !pcm.length) throw new Error("decodeClipPcm produced no pcm");
  return pcm;
}

/**
 * Speed up PCM by `factor` WITHOUT preserving pitch (asetrate resample, the "chipmunk" method) —
 * pitch rises with tempo, for a more cartoonish/South Park delivery. Operates on s16le/24k/mono and
 * returns the same format. `factor` 1 (or empty pcm) is a no-op. Applied to the host dialogue
 * (`DIALOGUE_SPEED`, fixed at 1.0 in this plan — a no-op pass-through); the intro/outro clips are
 * never sped.
 */
export async function speedUpPcm(o: { pcm?: Buffer | null; factor: number; runImpl?: Run }): Promise<Buffer> {
  const { pcm, factor, runImpl = spawnRun } = o;
  if (!pcm?.length || !(factor > 0) || factor === 1) return pcm ?? Buffer.alloc(0);
  const newRate = Math.round(SAMPLE_RATE * factor);
  const args = [
    "-hide_banner",
    "-loglevel",
    "error",
    "-f",
    "s16le",
    "-ar",
    String(SAMPLE_RATE),
    "-ac",
    "1",
    "-i",
    "pipe:0",
    "-af",
    `asetrate=${newRate},aresample=${SAMPLE_RATE}`,
    "-ac",
    "1",
    "-f",
    "s16le",
    "pipe:1",
  ];
  const out = await runImpl("ffmpeg", args, { input: pcm });
  if (!out || !out.length) throw new Error("speedUpPcm produced no pcm");
  return out;
}

/** Short hash keying an intro/outro cache entry to the finished clip's file identity only. */
export function clipCacheKey(o: { clipStat: { size: number; mtimeMs: number } }): string {
  const { clipStat } = o;
  return crypto
    .createHash("sha1")
    .update(`clip|${clipStat.size}|${Math.round(clipStat.mtimeMs)}`)
    .digest("hex")
    .slice(0, 16);
}

/** One cache file path under `cacheDir`, embedding the key + kind ('intro' | 'outro'). */
export function jingleCachePath(o: { cacheDir: string; key: string; kind: string }): string {
  const { cacheDir, key, kind } = o;
  return path.join(cacheDir, `jingle-${key}.${kind}.pcm`);
}

/** The subset of `node:fs` the audio cache needs, so tests can inject an in-memory fake. */
export type FsLike = AtomicFsLike & {
  existsSync: (p: string) => boolean;
  readFileSync: (p: string) => Buffer;
  writeFileSync: (p: string, b: Buffer) => void;
  mkdirSync: (p: string, o?: { recursive?: boolean }) => void;
};

/** Load `file` if present + non-empty, else `build()` it, persist, and return the PCM buffer. */
export async function cachedPcm(o: { file: string; build: () => Promise<Buffer>; fsImpl?: FsLike }): Promise<Buffer> {
  const { file, build, fsImpl = fs } = o;
  if (fsImpl.existsSync(file)) {
    const pcm = fsImpl.readFileSync(file);
    if (pcm && pcm.length) return pcm;
  }
  const pcm = await build();
  // Atomic (tmp + rename): a truncated PCM at `file` would be reused by every later episode.
  writeFileAtomic(fsImpl, file, pcm);
  return pcm;
}
