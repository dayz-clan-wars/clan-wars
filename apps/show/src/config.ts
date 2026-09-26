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
  /** Default `/var/lib/clan-wars-show`, the plan-3 service's path. */
  cacheDir: string;
  /** True when SHOW_CACHE_DIR was set, so `--render` can use its own cache when it was not. */
  cacheDirSet: boolean;
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
    cacheDirSet: Boolean(env.SHOW_CACHE_DIR?.trim()),
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

/** `pg_try_advisory_lock` key for a show run. ⚠️ Never the bot's 8_531_207 (apps/bot/src/instance-lock.ts). */
export const SHOW_LOCK_KEY = 8_531_208;

export type ServiceConfig =
  | { enabled: false; databaseUrl: string }
  | {
      enabled: true;
      databaseUrl: string;
      base: ShowConfig;
      render: RenderConfig;
      discordToken: string;
      guildId: string;
      opsChannelId: string | null;
      forumChannelId: string;
      requireApproval: boolean;
      approverIds: string[];
      youtube: { clientId: string; clientSecret: string; refreshToken: string; playlistId: string };
      facebook: { pageId: string; accessToken: string } | null;
    };

const SNOWFLAKE = /^\d{17,20}$/u;
/** ⚠️ Fails closed: only 1/true/0/false. A typo like "on" throws rather than turning approval off. */
const flag = (env: NodeJS.ProcessEnv, key: string, dflt: boolean): boolean => {
  const s = env[key]?.trim().toLowerCase();
  if (!s) return dflt;
  if (s === "1" || s === "true") return true;
  if (s === "0" || s === "false") return false;
  throw new Error(`${key} must be 1, true, 0 or false, got "${env[key]}"`);
};
function snowflake(env: NodeJS.ProcessEnv, key: string): string {
  const v = required(env, key);
  if (!SNOWFLAKE.test(v)) throw new Error(`${key} must be a Discord id, got "${v}"`);
  return v;
}

/**
 * The scheduled service's config (spec §13). Off unless SHOW_ENABLED, and then it needs
 * nothing but DATABASE_URL, so the timer can be installed before the keys exist.
 */
export function loadServiceConfig(env: NodeJS.ProcessEnv = process.env): ServiceConfig {
  const databaseUrl = required(env, "DATABASE_URL");
  if (!flag(env, "SHOW_ENABLED", false)) return { enabled: false, databaseUrl };

  const requireApproval = flag(env, "SHOW_REQUIRE_APPROVAL", true);
  const opsRaw = env.OPS_CHANNEL_ID?.trim() || null;
  if (opsRaw !== null && !SNOWFLAKE.test(opsRaw)) throw new Error(`OPS_CHANNEL_ID must be a Discord id, got "${opsRaw}"`);
  // ⚠️ With approval on, the draft has nowhere to go without the ops channel, and no one can approve it without approvers.
  if (requireApproval && opsRaw === null) throw new Error("OPS_CHANNEL_ID is required while SHOW_REQUIRE_APPROVAL is on");
  const approverIds = (env.SHOW_APPROVER_DISCORD_IDS ?? "").split(",").map((s) => s.trim()).filter((s) => s !== "");
  for (const id of approverIds) if (!SNOWFLAKE.test(id)) throw new Error(`SHOW_APPROVER_DISCORD_IDS: "${id}" is not a Discord id`);
  if (requireApproval && approverIds.length === 0) throw new Error("SHOW_APPROVER_DISCORD_IDS is required while SHOW_REQUIRE_APPROVAL is on");

  const pageId = env.FACEBOOK_PAGE_ID?.trim() || "";
  const pageToken = env.FACEBOOK_PAGE_ACCESS_TOKEN?.trim() || "";
  if (Boolean(pageId) !== Boolean(pageToken)) throw new Error("FACEBOOK_PAGE_ID and FACEBOOK_PAGE_ACCESS_TOKEN go together: set both or neither");

  return {
    enabled: true,
    databaseUrl,
    base: loadConfig(env),
    render: loadRenderConfig(env),
    discordToken: required(env, "DISCORD_TOKEN"),
    guildId: snowflake(env, "DISCORD_GUILD_ID"),
    opsChannelId: opsRaw,
    forumChannelId: snowflake(env, "SHOW_FORUM_CHANNEL_ID"),
    requireApproval,
    approverIds,
    youtube: {
      clientId: required(env, "YOUTUBE_CLIENT_ID"),
      clientSecret: required(env, "YOUTUBE_CLIENT_SECRET"),
      refreshToken: required(env, "YOUTUBE_REFRESH_TOKEN"),
      playlistId: required(env, "YOUTUBE_PLAYLIST_ID"),
    },
    facebook: pageId ? { pageId, accessToken: pageToken } : null,
  };
}
