import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { StoryContext } from "../story/types.js";
import { ASSETS } from "../assets.js";
import type { Run } from "../engine/run.js";
import { spawnRun } from "../engine/run.js";
import type { ChatFn } from "../engine/llm/openrouter.js";
import { parseDialogue } from "../engine/audio/parseDialogue.js";
import { buildDialogueScript } from "../engine/audio/buildDialogueScript.js";
import { resolveCachedPronouncer } from "../engine/audio/pronounceCached.js";
import type { PronunciationStore } from "../engine/audio/pronunciationStore.js";
import { synthesizeElevenPcmTimed } from "../engine/audio/elevenlabs.js";
import { encodeMp3 } from "../engine/audio/encodeMp3.js";
import { loadOrBuildSegment } from "../engine/audio/episode.js";
import { assembleShowEpisode, clipCacheKey, decodeClipPcm, speedUpPcm, type FsLike, type Span } from "../engine/audio/jingle.js";
import { buildSegmentTimeline, type TimelineTurn } from "../engine/animation/visemeTimeline.js";
import { defaultRhubarbRun, type RhubarbRun } from "../engine/animation/visemes.js";
import { episodeCacheKey, readEpisodeCache, writeEpisodeCache, type CacheFsLike } from "../engine/animation/episodeCache.js";
import type { ClipSpan } from "../engine/video/renderShowVideo.js";
import { collectNames } from "./names.js";

// Replaces KOTH's `buildShowEpisodeAudio` (bot/src/discord/showNotifier.js at a5ef8e7, the
// ElevenLabs branch) and follows its order of operations. Only the data sources change: names
// come from the StoryContext (`collectNames`) instead of the weekly boards.

const SHOW_OVERLAP = { intro: 1000, outro: 0 }; // ms: intro crossfades into the dialogue; dialogue -> outro is a clean gap
// Fixed at 1.0 (global constraints): the viseme timeline is computed against the UN-sped PCM, so any
// other value desyncs the lip sync.
const DIALOGUE_SPEED = 1.0;
const SR = 24000; // pipeline rate (matches encodeMp3)
const REDACTED_IN_TEXT = /REDACTED_(?:PLAYER|CLAN)_\d+/g;

/** The node:fs subset voiceEpisode and everything it drives needs (real `fs` satisfies it). */
export type VoiceFs = FsLike &
  CacheFsLike & {
  statSync: (p: string) => { size: number; mtimeMs: number };
  mkdtempSync: (prefix: string) => string;
  rmSync: (p: string, o?: { recursive?: boolean; force?: boolean }) => void;
};

export type VoiceDeps = {
  chat: ChatFn;
  pronunciationModel: string;
  store: PronunciationStore;
  overrides: Record<string, string>;
  elevenApiKey: string;
  elevenModel: string;
  borisVoiceId: string;
  pavelVoiceId: string;
  cacheDir: string;
  /** Rhubarb binary (RenderConfig, Task 11). Used unless `rhubarbRun` is supplied. */
  rhubarbPath: string;
  /** Every ffmpeg call, and the default Rhubarb call, goes through this. Defaults to `spawnRun`. */
  runImpl?: Run;
  fetchImpl?: typeof fetch;
  rhubarbRun?: RhubarbRun;
  fsImpl?: VoiceFs;
};

export type VoicedEpisode = {
  key: string;
  mp3Path: string;
  totalSec: number;
  segASpan: ClipSpan;
  outroSpan: ClipSpan;
  timeline: TimelineTurn[];
};

/** What `spans.json` in the episode cache holds for this app. */
type CachedSpans = { introSpan: ClipSpan | null; segASpan: ClipSpan; outroSpan: ClipSpan; totalSec: number };

/** Assembly marks are `{startSec,endSec}`; the video side takes `{startSec,durSec}`. Converted once, here. */
const spanOf = (m: Span | undefined): ClipSpan | null => (m ? { startSec: m.startSec, durSec: m.endSec - m.startSec } : null);

/**
 * Voice one episode: ElevenLabs per turn, Rhubarb per turn, intro/outro jingles, one mp3. Cached
 * under `<cacheDir>/<key>/` keyed on the week and narrative; a hit makes no external call at all.
 * Throws on any failure (KOTH returned null for a text-only post; this app's stage retries instead).
 */
export async function voiceEpisode(
  deps: VoiceDeps,
  ep: { weekStart: string; narrative: string; context: StoryContext },
): Promise<VoicedEpisode> {
  const { cacheDir, runImpl = spawnRun, fetchImpl, borisVoiceId, pavelVoiceId } = deps;
  const fsImpl: VoiceFs = deps.fsImpl ?? fs;
  const { weekStart, narrative, context } = ep;

  const key = episodeCacheKey({ weekStart, narrative });
  const mp3Path = path.join(cacheDir, key, "episode.mp3");
  const hit = readEpisodeCache({ fsImpl }, { cacheDir, key });
  if (hit) {
    const spans = hit.spans as CachedSpans;
    return {
      key,
      mp3Path,
      totalSec: spans.totalSec,
      segASpan: spans.segASpan,
      outroSpan: spans.outroSpan,
      timeline: hit.segATimeline as TimelineTurn[],
    };
  }

  const turns = parseDialogue(narrative);
  if (!turns.length) throw new Error("voiceEpisode: the narrative has no dialogue (no Boris:/Pavel: lines)");

  // Aliases are resolved to their spoken form and replaced in speech like any name. Any alias the
  // script uses that the context does not carry is picked up from the narrative too, so the TTS
  // never reads a raw `REDACTED_*`.
  const { names, aliases } = collectNames(context);
  const narrativeAliases = narrative.match(REDACTED_IN_TEXT) ?? [];
  const allAliases = [...new Set([...aliases, ...narrativeAliases])];
  const tags = [...new Set([...names, ...allAliases])];
  const pronounce = await resolveCachedPronouncer({
    store: deps.store,
    names: tags,
    overrides: deps.overrides,
    chat: deps.chat,
    model: deps.pronunciationModel,
  });

  const runRhubarb: RhubarbRun =
    deps.rhubarbRun ?? ((a) => defaultRhubarbRun({ ...a, rhubarbPath: deps.rhubarbPath, fsImpl, runImpl }));
  const workDir = fsImpl.mkdtempSync(path.join(os.tmpdir(), "show-visemes-"));
  let segAPcm: Buffer;
  let timeline: TimelineTurn[];
  try {
    const inputs = buildDialogueScript(turns, { gamertags: tags, pronounce, borisVoiceId, pavelVoiceId });
    if (!inputs.length) throw new Error("voiceEpisode: the script has no speakable lines");
    const { pcm, turns: spans } = await synthesizeElevenPcmTimed({
      inputs,
      apiKey: deps.elevenApiKey,
      modelId: deps.elevenModel,
      fetchImpl,
    });
    timeline = await buildSegmentTimeline(
      { runRhubarb, runFfmpeg: runImpl, fsImpl, rhubarbPath: deps.rhubarbPath },
      { segmentPcm: pcm, turns: spans, borisVoiceId, workDir },
    );
    segAPcm = await speedUpPcm({ pcm, factor: DIALOGUE_SPEED, runImpl });
  } finally {
    try {
      fsImpl.rmSync(workDir, { recursive: true, force: true });
    } catch {
      /* best-effort */
    }
  }

  const jingleDir = path.join(cacheDir, ".jingle-cache");
  const jingle = (srcPath: string, kind: "intro" | "outro") =>
    loadOrBuildSegment({
      srcPath,
      cacheDir: jingleDir,
      fsImpl,
      kind,
      key: fsImpl.existsSync(srcPath) ? clipCacheKey({ clipStat: fsImpl.statSync(srcPath) }) : null,
      build: () => decodeClipPcm({ clipPath: srcPath, runImpl }),
    });
  const introPcm = await jingle(ASSETS.introMp3, "intro");
  const outroPcm = await jingle(ASSETS.outroMp3, "outro");

  const { pcm, marks } = assembleShowEpisode(
    { introPcm, segAPcm, outroPcm },
    { introOverlapMs: SHOW_OVERLAP.intro, outroOverlapMs: SHOW_OVERLAP.outro },
  );
  const segASpan = spanOf(marks.segA);
  const outroSpan = spanOf(marks.outro);
  // KOTH fell back to a static title-card video without these; that path is not ported (spec §11.2).
  if (!segASpan || !outroSpan) throw new Error("voiceEpisode: the episode has no dialogue or no outro jingle");
  const mp3 = await encodeMp3(pcm, { runImpl });
  const totalSec = pcm.length / 2 / SR;

  // Not best-effort as in KOTH: `mp3Path` points into the cache, so the write must land.
  const spans: CachedSpans = { introSpan: spanOf(marks.intro), segASpan, outroSpan, totalSec };
  writeEpisodeCache({ fsImpl }, { cacheDir, key, mp3, segATimeline: timeline, spans });
  return { key, mp3Path, totalSec, segASpan, outroSpan, timeline };
}
