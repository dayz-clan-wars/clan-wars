import { DEFAULT_DORMANT_AFTER_MS, DEFAULT_DISBAND_AFTER_DORMANT_MS } from "./dormancy.js";
import { REBIND_COOLDOWN_MS, RELEASE_GRACE_MS } from "./rebind.js";

export type BotConfig = {
  token: string;
  applicationId: string;
  guildId: string;
  databaseUrl: string;
  tickIntervalMs: number;
  challengeTtlMs: number;
  reservationTtlMs: number;
  inviteTtlMs: number;
  cooldownMs: number;
  renameCooldownMs: number;
  dormantAfterMs: number;
  disbandAfterDormantMs: number;
  rebindCooldownMs: number;
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

/** Env in, config out. Takes the environment as an argument so failure paths are testable. */
export function loadConfig(env: NodeJS.ProcessEnv): BotConfig {
  const config: BotConfig = {
    token: required(env, "DISCORD_TOKEN"),
    applicationId: required(env, "DISCORD_APPLICATION_ID"),
    guildId: required(env, "DISCORD_GUILD_ID"),
    databaseUrl: required(env, "DATABASE_URL"),
    tickIntervalMs: positiveInt(env, "BOT_TICK_INTERVAL_MS", 10_000),
    // 24 hours, matching one-life; safe because a challenge names its target
    // and cannot be stolen by another character performing the sequence.
    challengeTtlMs: positiveInt(env, "BOT_CHALLENGE_TTL_MS", 86_400_000),
    reservationTtlMs: positiveInt(env, "BOT_RESERVATION_TTL_MS", 86_400_000),
    // 7 days — spec §6 invite lifetime.
    inviteTtlMs: positiveInt(env, "BOT_INVITE_TTL_MS", 604_800_000),
    // 3 days — spec §6 kick/leave cooldown.
    cooldownMs: positiveInt(env, "BOT_COOLDOWN_MS", 259_200_000),
    // 7 days — spec §6 rename cooldown.
    renameCooldownMs: positiveInt(env, "BOT_RENAME_COOLDOWN_MS", 604_800_000),
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
    // 7 days — spec §2.5. Validated below against RELEASE_GRACE_MS: this env
    // var, not the RELEASE_GRACE_MS/REBIND_COOLDOWN_MS constants that
    // apps/bot/test/rebind.test.ts pins, is what the handlers actually use.
    rebindCooldownMs: positiveInt(env, "BOT_REBIND_COOLDOWN_MS", REBIND_COOLDOWN_MS),
    feedChannelId: optionalSnowflake(env, "BOT_FEED_CHANNEL_ID"),
  };

  // ⚠️ A cooldown at or below RELEASE_GRACE_MS lets a faction alternate
  // between two poles and hold both permanently private — the pole it just
  // left stays reserved to it through the release grace, and by the time
  // that grace ends the cooldown has already expired, so it can rebind back.
  // Nothing about a live bot would error if this were misconfigured; it
  // would just quietly reopen the exploit dormancy and rebind.test.ts assume
  // is closed.
  if (config.rebindCooldownMs <= RELEASE_GRACE_MS) {
    throw new Error(
      `BOT_REBIND_COOLDOWN_MS must be strictly greater than RELEASE_GRACE_MS ` +
      `(${RELEASE_GRACE_MS}), got ${config.rebindCooldownMs}: a cooldown at or ` +
      `below the release grace lets a faction hold two private bases.`,
    );
  }

  return config;
}
