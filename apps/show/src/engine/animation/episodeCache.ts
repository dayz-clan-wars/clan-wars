import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { copyFileAtomic, writeFileAtomic, type AtomicFsLike } from "../atomicWrite.js";

// Ported from KOTH bot/src/animation/episodeCache.js at a5ef8e7, typed. `episodeCacheKey` is a
// named change (global-context.md): KOTH keyed on a numeric `weekStartTs`; this plan keys on the
// ISO week-start string with `:` and `.` replaced by `-` so the key is always a safe directory
// name.

// Each function below takes only the `node:fs` subset it needs (structurally compatible with real
// `fs`, so the default keeps working, and tests can inject the narrower fake each one requires).
export type CacheFsLike = AtomicFsLike & {
  existsSync: (p: string) => boolean;
  readFileSync: (p: string) => Buffer;
  writeFileSync: (p: string, d: Buffer | string) => void;
  mkdirSync: (p: string, o?: { recursive?: boolean }) => void;
};
export type VideoWriteFsLike = AtomicFsLike & {
  existsSync: (p: string) => boolean;
  mkdirSync: (p: string, o?: { recursive?: boolean }) => void;
  copyFileSync: (src: string, dest: string) => void;
  readdirSync: (p: string) => string[];
  rmSync: (p: string, o?: { force?: boolean }) => void;
};
export type VideoReadFsLike = {
  existsSync: (p: string) => boolean;
  statSync: (p: string) => { size: number };
};

/**
 * The 12-hex cut id: sha1(narrative)[0:12]. One definition, shared by the cache key and the ops
 * draft marker, so "the same cut" means the same thing everywhere (spec §8.3).
 */
export function cutHash(narrative: string): string {
  return crypto.createHash("sha1").update(String(narrative ?? "")).digest("hex").slice(0, 12);
}

/** Cache key = weekStart + a short hash of the narrative (audio is a pure function of the narrative). */
export function episodeCacheKey(o: { weekStart: string; narrative: string }): string {
  const { weekStart, narrative } = o;
  const safeWeekStart = weekStart.replace(/[:.]/g, "-");
  return `${safeWeekStart}-${cutHash(narrative)}`;
}

function files(dir: string) {
  return {
    mp3: path.join(dir, "episode.mp3"),
    segA: path.join(dir, "segA-timeline.json"),
    spans: path.join(dir, "spans.json"),
  };
}

export type EpisodeCacheArtifacts = { mp3: Buffer; segATimeline: unknown; spans: unknown };

/** Persist the synthesis artifacts under <cacheDir>/<key>/. Returns the subdir. */
export function writeEpisodeCache(
  deps: { fsImpl?: CacheFsLike } = {},
  o: { cacheDir: string; key: string; mp3: Buffer; segATimeline: unknown; spans: unknown },
): string {
  const { fsImpl = fs } = deps;
  const { cacheDir, key, mp3, segATimeline, spans } = o;
  const dir = path.join(cacheDir, key);
  fsImpl.mkdirSync(dir, { recursive: true });
  const f = files(dir);
  // Each file lands atomically (tmp + rename), and spans.json goes LAST: `readEpisodeCache` needs
  // every file, so a run that dies partway leaves a miss, never a partial hit.
  writeFileAtomic(fsImpl, f.mp3, mp3);
  writeFileAtomic(fsImpl, f.segA, JSON.stringify(segATimeline));
  writeFileAtomic(fsImpl, f.spans, JSON.stringify(spans));
  return dir;
}

/** Load the artifacts, or null if the subdir or ANY file is missing/unparseable (never partial). */
export function readEpisodeCache(
  deps: { fsImpl?: CacheFsLike } = {},
  o: { cacheDir: string; key: string },
): EpisodeCacheArtifacts | null {
  const { fsImpl = fs } = deps;
  const { cacheDir, key } = o;
  const dir = path.join(cacheDir, key);
  const f = files(dir);
  try {
    for (const p of Object.values(f)) if (!fsImpl.existsSync(p)) return null;
    const mp3 = fsImpl.readFileSync(f.mp3);
    if (!mp3 || !mp3.length) return null;
    return {
      mp3,
      segATimeline: JSON.parse(fsImpl.readFileSync(f.segA).toString()),
      spans: JSON.parse(fsImpl.readFileSync(f.spans).toString()),
    };
  } catch {
    return null;
  }
}

/** Persist the rendered mp4 under <cacheDir>/<key>/video.mp4, pruning every OTHER key's video. */
export function writeEpisodeVideo(
  deps: { fsImpl?: VideoWriteFsLike } = {},
  o: { cacheDir: string; key: string; videoPath: string },
): string {
  const { fsImpl = fs } = deps;
  const { cacheDir, key, videoPath } = o;
  const dir = path.join(cacheDir, key);
  fsImpl.mkdirSync(dir, { recursive: true });
  const dest = path.join(dir, "video.mp4");
  // Atomic (tmp + rename): a copy that dies midway never leaves a truncated video.mp4 that
  // `readEpisodeVideoPath` would return as a hit.
  copyFileAtomic(fsImpl, videoPath, dest);
  // Keep only this episode's ~30MB video; the video is only reused transiently (this episode's
  // YouTube->Facebook, or an immediate re-run), so prune all other keys' videos (leave audio).
  try {
    for (const entry of fsImpl.readdirSync(cacheDir)) {
      if (entry === key) continue;
      const other = path.join(cacheDir, entry, "video.mp4");
      if (fsImpl.existsSync(other)) fsImpl.rmSync(other, { force: true });
    }
  } catch {
    /* best-effort prune */
  }
  return dest;
}

/** Path to the cached mp4 if present and non-empty, else null (never a partial/zero-byte path). */
export function readEpisodeVideoPath(deps: { fsImpl?: VideoReadFsLike } = {}, o: { cacheDir: string; key: string }): string | null {
  const { fsImpl = fs } = deps;
  const { cacheDir, key } = o;
  const p = path.join(cacheDir, key, "video.mp4");
  try {
    if (!fsImpl.existsSync(p)) return null;
    const st = fsImpl.statSync(p);
    if (!st || !st.size) return null;
    return p;
  } catch {
    return null;
  }
}
