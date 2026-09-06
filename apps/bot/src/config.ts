import { DEFAULT_DORMANT_AFTER_MS, DEFAULT_DISBAND_AFTER_DORMANT_MS } from "./dormancy.js";

export type BotConfig = {
  token: string;
  applicationId: string;
  guildId: string;
  databaseUrl: string;
  tickIntervalMs: number;
  dormantAfterMs: number;
  disbandAfterDormantMs: number;
  /**
   * The faction feed's channel. Undefined means the feed is OFF: rows keep
   * accumulating in `faction_events` and nothing posts.
   *
   * ⚠️ Optional rather than required, for two reasons. Required would make
   * every existing deployment and test fixture supply a channel id for a
   * feature they do not use — and, worse, a development or staging bot that
   * inherited a copied `.env` would post into a live community channel.
   * Silent by default is the safe direction.
   */
  feedChannelId: string | undefined;
  /**
   * Base URL the flag images are served from — `https://dayzclanwars.com`.
   * Undefined means embeds post with no thumbnail, exactly as they did before
   * any artwork existed.
   */
  flagImageBaseUrl: string | undefined;
  /**
   * Bare origin of the site — `https://dayzclanwars.com`. Every retired
   * slash command's reply and the ceremony DM point players here.
   */
  siteBaseUrl: string;
};

function required(env: NodeJS.ProcessEnv, key: string): string {
  const v = env[key];
  if (!v) throw new Error(`${key} is not set. The bot cannot start without it.`);
  return v;
}

/** Plain base-10 digits only. See the comment in positiveInt for why. */
const DECIMAL_RE = /^\d+$/u;

function positiveInt(env: NodeJS.ProcessEnv, key: string, fallback: number): number {
  const raw = env[key];
  if (raw === undefined || raw === "") return fallback;

  // Matched against digits BEFORE coercion, because bare Number() quietly
  // accepts forms nobody types into a config on purpose: Number("0x10") is 16,
  // so a typo'd interval would run this bot's database loop 60 times a second
  // while looking correctly configured; Number("1e3") and Number(" 10 ")
  // likewise succeed. A silently-defaulted interval is a bot that looks
  // configured and is not — and a silently-reinterpreted one is worse, because
  // the value is visibly present and still wrong.
  const n = DECIMAL_RE.test(raw) ? Number(raw) : Number.NaN;
  if (!Number.isSafeInteger(n) || n <= 0) {
    throw new Error(
      `${key} must be a positive integer in plain decimal digits, got ${JSON.stringify(raw)}.`,
    );
  }
  return n;
}

// ⚠️ No leading zero: a real snowflake is a Twitter-epoch timestamp in its
// high bits and is never 0 there, so `\d` here would accept a placeholder
// like "000000000000000000" as valid. The README's example .env shipped
// exactly that value and it passed this regex — a copy-paste config loaded
// clean, then every post failed and blocked the queue at row one.
const SNOWFLAKE_RE = /^[1-9]\d{16,19}$/u;

/**
 * ⚠️ Validated at load, not at first post. An unset feed is silent by
 * design, so a malformed id would be indistinguishable from an off feed
 * until someone noticed the channel had been empty for a week.
 */
function optionalSnowflake(env: NodeJS.ProcessEnv, key: string): string | undefined {
  const raw = env[key];
  if (raw === undefined || raw === "") return undefined;
  if (!SNOWFLAKE_RE.test(raw)) {
    throw new Error(
      `${key} must be a Discord channel id — 17 to 20 digits — got ${JSON.stringify(raw)}. ` +
      "Copy it with Developer Mode enabled: right-click the channel, Copy Channel ID.",
    );
  }
  return raw;
}

/**
 * ⚠️ Validated at load, not at first use — the same reasoning as
 * `optionalSnowflake` directly above. An unset base is silent by design, so a
 * malformed one would be indistinguishable from an unconfigured one until
 * somebody noticed the embeds had lost their thumbnails.
 *
 * ⚠️ Must be a bare origin — no path, query, fragment or credentials. The
 * resolver appends `/flags/<texture>.png` itself, so anything already in the
 * path (an operator pasting the flags directory URL they were just looking
 * at, e.g. `https://dayzclanwars.com/flags/`) produces a URL that resolves to
 * nothing, with no error here and none at post time either — Discord just
 * renders the embed with no thumbnail, the exact silent failure this
 * validator exists to prevent. Credentials are rejected for a different
 * reason: `https://user:pass@host` would be preserved verbatim into a URL
 * that Discord's embed proxy then fetches, leaking them somewhere we do not
 * control.
 */
function optionalHttpUrl(env: NodeJS.ProcessEnv, key: string): string | undefined {
  const raw = env[key];
  if (raw === undefined || raw === "") return undefined;
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new Error(`${key} must be an absolute URL, got ${JSON.stringify(raw)}.`);
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    throw new Error(`${key} must be http or https, got ${JSON.stringify(parsed.protocol)}.`);
  }
  if (parsed.pathname !== "/" && parsed.pathname !== "") {
    throw new Error(
      `${key} must be a bare origin with no path — got a path of ${JSON.stringify(parsed.pathname)}. ` +
      `The bot appends the page path itself; use ${JSON.stringify(parsed.origin)}.`,
    );
  }
  if (parsed.search !== "") {
    throw new Error(
      `${key} must be a bare origin with no query string — got ${JSON.stringify(parsed.search)}. ` +
      `Use ${JSON.stringify(parsed.origin)}.`,
    );
  }
  if (parsed.hash !== "") {
    throw new Error(
      `${key} must be a bare origin with no fragment — got ${JSON.stringify(parsed.hash)}. ` +
      `Use ${JSON.stringify(parsed.origin)}.`,
    );
  }
  if (parsed.username !== "" || parsed.password !== "") {
    throw new Error(
      `${key} must be a bare origin with no embedded credentials. ` +
      `Use ${JSON.stringify(parsed.origin)} and put any auth elsewhere.`,
    );
  }
  return raw;
}

/** Env in, config out. Takes the environment as an argument so failure paths are testable. */
export function loadConfig(env: NodeJS.ProcessEnv): BotConfig {
  const config: BotConfig = {
    token: required(env, "DISCORD_TOKEN"),
    applicationId: required(env, "DISCORD_APPLICATION_ID"),
    guildId: required(env, "DISCORD_GUILD_ID"),
    databaseUrl: required(env, "DATABASE_URL"),
    tickIntervalMs: positiveInt(env, "BOT_TICK_INTERVAL_MS", 10_000),
    // 7 days, matching the server's FlagRefreshMaxDuration. ⚠️ Copied by hand:
    // change one and not the other and they diverge silently, either cutting
    // supplies at a base that is fine or feeding one that has already decayed.
    // The server's own value is readable from cfggameplay.json — see the
    // dormancy design's §7 for why that is not wired up yet.
    //
    // The fallback itself comes from dormancy.ts, not a repeated literal:
    // that constant is also what the test suite asserts against, so editing
    // it here alone would leave production on the old value while every test
    // stayed green.
    dormantAfterMs: positiveInt(env, "BOT_DORMANT_AFTER_MS", DEFAULT_DORMANT_AFTER_MS),
    // 14 further days before the flag, tag and pole return to the 33-slot pool.
    disbandAfterDormantMs: positiveInt(env, "BOT_DISBAND_AFTER_DORMANT_MS", DEFAULT_DISBAND_AFTER_DORMANT_MS),
    feedChannelId: optionalSnowflake(env, "BOT_FEED_CHANNEL_ID"),
    flagImageBaseUrl: optionalHttpUrl(env, "FLAG_IMAGE_BASE_URL"),
    siteBaseUrl: optionalHttpUrl(env, "SITE_BASE_URL") ?? "https://dayzclanwars.com",
  };

  return config;
}
