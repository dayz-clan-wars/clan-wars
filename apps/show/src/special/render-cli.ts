import fs from "node:fs";
import path from "node:path";
import { DEFAULT_MODEL, loadRenderConfig } from "../config.js";
import { MemoryPronunciationStore } from "../engine/audio/pronunciationStore.js";
import { createChat } from "../engine/llm/openrouter.js";
import { spawnRun, type Run } from "../engine/run.js";
import { preflightRender, renderCacheDir } from "../produce/preflight.js";
import { renderEpisode, type SpecialVisuals } from "../produce/render.js";
import { voiceEpisode, type VoicedEpisode } from "../produce/voice.js";
import { createModerator } from "../screening/moderate.js";
import { screenScript } from "../script/write-script.js";
import { loadSpecial } from "./load.js";

/**
 * Stands in for the week in the voice cache key. ⚠️ Never a date: a special's cut must not share
 * a cache entry, or a key prefix, with any weekly episode's.
 */
export const specialCacheKeyWeek = (slug: string) => `special:${slug}`;

export type SpecialRenderIo = {
  preflight: () => Promise<void>;
  /** The weekly output screen (blocklist + moderation); [] means it passed. */
  screen: (narrative: string) => Promise<string[]>;
  voice: (ep: { weekStart: string; narrative: string; names: { names: string[]; aliases: string[] } }) => Promise<VoicedEpisode>;
  render: (ep: { voiced: VoicedEpisode; special: SpecialVisuals }) => Promise<string>;
  log: (s: string) => void;
};

/**
 * The real wiring. ⚠️ Opens no database and needs no DATABASE_URL: this runs on a laptop, and a
 * special has no week to read. Pronunciations live in memory for the one run.
 */
function realIo(out: string, env: NodeJS.ProcessEnv = process.env): SpecialRenderIo {
  const apiKey = env.OPENROUTER_API_KEY?.trim();
  if (!apiKey) throw new Error("OPENROUTER_API_KEY is required (moderation and pronunciation)");
  const renderCfg = loadRenderConfig(env);
  const cacheDir = renderCacheDir(renderCfg, out);
  const runImpl: Run = (cmd, args, o) => spawnRun(cmd === "ffmpeg" ? renderCfg.ffmpegPath : cmd, args, o);
  const chat = createChat({ apiKey });
  const moderate = createModerator({ chat, model: env.SHOW_MODERATION_MODEL?.trim() || DEFAULT_MODEL });
  return {
    preflight: () => preflightRender({ cacheDir, ffmpegPath: renderCfg.ffmpegPath, rhubarbPath: renderCfg.rhubarbPath }),
    screen: (narrative) => screenScript(narrative, [], moderate),
    voice: (ep) => voiceEpisode({
      chat, pronunciationModel: renderCfg.pronunciationModel, store: new MemoryPronunciationStore(), overrides: renderCfg.pronunciationOverrides,
      elevenApiKey: renderCfg.elevenApiKey, elevenModel: renderCfg.elevenModel, borisVoiceId: renderCfg.borisVoiceId, pavelVoiceId: renderCfg.pavelVoiceId,
      cacheDir, rhubarbPath: renderCfg.rhubarbPath, runImpl,
    }, ep),
    render: (ep) => renderEpisode({ cacheDir, discordInvite: renderCfg.discordInvite, runImpl }, ep),
    log: (s) => console.log(s),
  };
}

/** `--special <dir> --render <out>`: screen, voice and render a special into `<out>`. Returns the exit code. */
export async function runSpecialRender(o: { dir: string; out: string }, io?: SpecialRenderIo): Promise<number> {
  const special = loadSpecial(o.dir);
  const deps = io ?? realIo(o.out);
  await deps.preflight();
  // ⚠️ Fails closed, like the weekly script stage: a script the screen holds is never voiced.
  const reasons = await deps.screen(special.narrative);
  if (reasons.length > 0) {
    deps.log(`HELD by the script screen:\n${reasons.join("\n")}`);
    return 1;
  }
  const voiced = await deps.voice({
    weekStart: specialCacheKeyWeek(special.slug),
    narrative: special.narrative,
    names: { names: special.pronounce, aliases: [] },
  });
  const videoPath = await deps.render({
    voiced,
    special: { introScreenPath: special.introPath, outroStillPath: special.outroPath, cards: special.cards, marqueeItems: special.marquee },
  });
  fs.mkdirSync(o.out, { recursive: true });
  const outMp3 = path.join(o.out, "episode.mp3");
  const outMp4 = path.join(o.out, "video.mp4");
  fs.copyFileSync(voiced.mp3Path, outMp3);
  fs.copyFileSync(videoPath, outMp4);
  deps.log(`RENDERED\n${outMp3}\n${outMp4}\nduration: ${voiced.totalSec.toFixed(1)}s`);
  return 0;
}
