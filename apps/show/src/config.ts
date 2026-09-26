import fs from "node:fs";

/** The KOTH show's production model; proven on this exact job. */
export const DEFAULT_MODEL = "anthropic/claude-sonnet-4.6";

export type ShowConfig = {
  databaseUrl: string;
  openrouterApiKey: string;
  scriptModel: string;
  moderationModel: string;
  /** Spec §5.4. By tag, because a player can name a clan anything. */
  staffTags: string[];
};

function required(env: NodeJS.ProcessEnv, key: string): string {
  const v = env[key]?.trim();
  if (!v) throw new Error(`${key} is required`);
  return v;
}

export type RenderConfig = {
  elevenApiKey: string;
  borisVoiceId: string;
  pavelVoiceId: string;
  elevenModel: string;
  pronunciationModel: string;
  rhubarbPath: string;
  ffmpegPath: string;
  cacheDir: string;
  discordInvite: string;
  /** `{ "<name>": "<spoken>" }`. Missing key -> `{}`. */
  pronunciationOverrides: Record<string, string>;
};

function loadPronunciationOverrides(env: NodeJS.ProcessEnv): Record<string, string> {
  const p = env.PRONUNCIATIONS_PATH?.trim();
  if (!p) return {};
  let raw: string;
  try {
    raw = fs.readFileSync(p, "utf8");
  } catch (err) {
    throw new Error(`PRONUNCIATIONS_PATH: could not read "${p}": ${(err as Error).message}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(`PRONUNCIATIONS_PATH: "${p}" is not valid JSON: ${(err as Error).message}`);
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error(`PRONUNCIATIONS_PATH: "${p}" must be a JSON object of {"<name>": "<spoken>"}`);
  }
  return parsed as Record<string, string>;
}

/**
 * Separate from `loadConfig` so a dry run needs no ElevenLabs key (spec/brief, Task 11).
 * `ffmpegPath` must reach every ffmpeg spawn: `produce/` wraps the default `runImpl` so
 * the command name `"ffmpeg"` maps to it, and every other command (the rhubarb path)
 * passes through unchanged (task-10-report.md).
 */
export function loadRenderConfig(env: NodeJS.ProcessEnv = process.env): RenderConfig {
  return {
    elevenApiKey: required(env, "ELEVENLABS_API_KEY"),
    borisVoiceId: required(env, "ELEVENLABS_BORIS_VOICE_ID"),
    pavelVoiceId: required(env, "ELEVENLABS_PAVEL_VOICE_ID"),
    elevenModel: env.ELEVENLABS_MODEL?.trim() || "eleven_multilingual_v2",
    pronunciationModel: env.SHOW_PRONUNCIATION_MODEL?.trim() || DEFAULT_MODEL,
    rhubarbPath: env.RHUBARB_PATH?.trim() || "rhubarb",
    ffmpegPath: env.FFMPEG_PATH?.trim() || "ffmpeg",
    cacheDir: env.SHOW_CACHE_DIR?.trim() || "/var/lib/clan-wars-show",
    discordInvite: env.SHOW_DISCORD_INVITE?.trim() || "discord.gg/TJu4XP25nr",
    pronunciationOverrides: loadPronunciationOverrides(env),
  };
}

/** Plan 1's keys only. Plan 3 adds publishing, approval and paths. */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): ShowConfig {
  return {
    databaseUrl: required(env, "DATABASE_URL"),
    openrouterApiKey: required(env, "OPENROUTER_API_KEY"),
    scriptModel: env.SHOW_SCRIPT_MODEL?.trim() || DEFAULT_MODEL,
    moderationModel: env.SHOW_MODERATION_MODEL?.trim() || DEFAULT_MODEL,
    staffTags: (env.SHOW_STAFF_CLAN_TAGS ?? "ADM").split(",").map((s) => s.trim()).filter((s) => s !== ""),
  };
}
