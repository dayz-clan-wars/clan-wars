import { DEFAULT_HIT_BURST_WINDOW_S, WEEKLY_WIPE_VEHICLES } from "@factions/domain";
import { DEFAULT_DORMANT_AFTER_MS, DEFAULT_DISBAND_AFTER_DORMANT_MS } from "./dormancy.js";
import { DEFAULT_KILLSTREAK_EVERY } from "./killstreak-feed-tick.js";
import { DEFAULT_LONG_RANGE_MIN_M } from "./long-range-feed-tick.js";

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
   * The war log's channel (spec §9.2's #war-log). Undefined means it is OFF:
   * `war_log_events` rows keep accumulating and nothing posts. Optional for
   * the same reason `feedChannelId` is: every existing deployment and test
   * fixture would otherwise need a channel id for a feature it does not use.
   */
  warLogChannelId: string | undefined;
  /** #kill-feed. Optional: the kill feed is off unless deliberately turned on. */
  killFeedChannelId?: string;
  /** #hit-feed. Optional: the hit feed is off unless deliberately turned on. */
  hitFeedChannelId?: string;
  /** #killstreaks. Optional, off unless set. */
  killstreakFeedChannelId?: string;
  /** #long-range. Optional, off unless set. */
  longRangeFeedChannelId?: string;
  /** The quiet gap that closes a hit engagement. ⚠️ The 120s settle floor still binds below this. */
  hitBurstWindowS: number;
  /** Post on every Nth kill of a streak. */
  killstreakEvery: number;
  /** Minimum distance, in metres, for #long-range. */
  longRangeMinM: number;
  /** #players-online: one message the bot keeps edited. Optional. */
  playersOnlineChannelId?: string;
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
  /**
   * Created by hand once (runbook); the bot never creates categories or `@Linked`,
   * only clan roles and channels inside them.
   */
  clanTextCategoryId: string;
  /**
   * Created by hand once (runbook); the bot never creates categories or `@Linked`,
   * only clan roles and channels inside them.
   */
  clanVoiceCategoryId: string;
  /**
   * Created by hand once (runbook); the bot never creates categories or `@Linked`,
   * only clan roles and channels inside them.
   */
  linkedRoleId: string;
  /**
   * Created by hand once (runbook); the bot never creates categories or
   * `@Alpha`, only clan roles and channels inside them.
   */
  alphaRoleId: string;
  /**
   * The achievements wall: a channel notice with no clan behind it, posted
   * alongside the normal clan-channel/DM notice for every unlock. Optional,
   * for the same reason `feedChannelId` is — unset by default, nothing posts.
   */
  achievementsChannelId: string | undefined;
  /**
   * Gates the achievements tick itself, default **off**. A fresh deploy must
   * run the backfill (spec §10) before the live tick starts evaluating
   * owners — turning it on first would race the backfill's watermarks and
   * skip or duplicate unlocks.
   */
  achievementsTick: boolean;
  /** Restart every active server on even UTC hours through Nitrado (spec 2026-09-12). Off by default. */
  restartSchedule: boolean;
  /** Per-clan spawn armbands, written into init.c on each restart slot. */
  armbands: boolean;
  /** Truck wipe. `events` empty means off; the window is only meaningful when it is not. */
  truckWipe: { events: string[]; offHour: number; onHour: number; rotation: boolean };
  /** Required when `restartSchedule` is on; the same token the ingest worker uses. */
  nitradoToken: string | undefined;
  /** Where the weekly wipe notice posts. Unset = the wipe still happens, silently. */
  announcementsChannelId?: string;
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

/** A snowflake that the bot cannot run without (spec §9.1: "refuses to start with any missing"). */
function requiredSnowflake(env: NodeJS.ProcessEnv, key: string, what: string): string {
  const raw = env[key];
  if (raw === undefined || raw === "") throw new Error(`${key} is not set. The bot cannot start without ${what}.`);
  if (!SNOWFLAKE_RE.test(raw)) {
    throw new Error(
      `${key} must be a Discord id — 17 to 20 digits — got ${JSON.stringify(raw)}. ` +
      "Copy it with Developer Mode enabled: right-click, Copy ID.",
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
    warLogChannelId: optionalSnowflake(env, "WAR_LOG_CHANNEL_ID"),
    killFeedChannelId: optionalSnowflake(env, "KILL_FEED_CHANNEL_ID"),
    hitFeedChannelId: optionalSnowflake(env, "HIT_FEED_CHANNEL_ID"),
    killstreakFeedChannelId: optionalSnowflake(env, "KILLSTREAK_FEED_CHANNEL_ID"),
    longRangeFeedChannelId: optionalSnowflake(env, "LONG_RANGE_FEED_CHANNEL_ID"),
    hitBurstWindowS: positiveInt(env, "HIT_BURST_WINDOW_S", DEFAULT_HIT_BURST_WINDOW_S),
    killstreakEvery: positiveInt(env, "KILLSTREAK_EVERY", DEFAULT_KILLSTREAK_EVERY),
    longRangeMinM: positiveInt(env, "LONG_RANGE_MIN_M", DEFAULT_LONG_RANGE_MIN_M),
    playersOnlineChannelId: optionalSnowflake(env, "PLAYERS_ONLINE_CHANNEL_ID"),
    flagImageBaseUrl: optionalHttpUrl(env, "FLAG_IMAGE_BASE_URL"),
    // ⚠️ Stripped of any trailing slash here, unlike FLAG_IMAGE_BASE_URL just
    // above — that resolver strips its own trailing slash at the point it
    // appends `/flags/<texture>.png`, but every consumer of siteBaseUrl
    // (raise-tick's rebind_proposed link, retired-commands' replies) builds
    // its own path by simple concatenation with no such strip, so a bare
    // origin with a trailing slash (`optionalHttpUrl` accepts one — its
    // pathname is `"/"`, which passes) would otherwise produce a doubled
    // slash in every link built from it.
    siteBaseUrl: (optionalHttpUrl(env, "SITE_BASE_URL") ?? "https://dayzclanwars.com").replace(/\/+$/u, ""),
    clanTextCategoryId: requiredSnowflake(env, "CLAN_TEXT_CATEGORY_ID", "the category clan text channels are created in"),
    clanVoiceCategoryId: requiredSnowflake(env, "CLAN_VOICE_CATEGORY_ID", "the category clan voice channels are created in"),
    linkedRoleId: requiredSnowflake(env, "LINKED_ROLE_ID", "the @Linked role"),
    alphaRoleId: requiredSnowflake(env, "ALPHA_ROLE_ID", "the @Alpha role"),
    achievementsChannelId: optionalSnowflake(env, "ACHIEVEMENTS_CHANNEL_ID"),
    achievementsTick: ["1", "true"].includes((env.ACHIEVEMENTS_TICK ?? "").toLowerCase()),
    restartSchedule: ["1", "true"].includes((env.RESTART_SCHEDULE ?? "").toLowerCase()),
    armbands: ["1", "true"].includes((env.CLAN_ARMBANDS ?? "").toLowerCase()),
    nitradoToken: env.NITRADO_TOKEN?.trim() || undefined,
    truckWipe: {
      events: (env.TRUCK_WIPE_EVENTS ?? "").split(",").map((e) => e.trim()).filter((e) => e !== ""),
      offHour: wipeHour(env, "TRUCK_WIPE_OFF_HOUR", 8),
      onHour: wipeHour(env, "TRUCK_WIPE_ON_HOUR", 10),
      rotation: ["1", "true"].includes((env.WEEKLY_VEHICLE_WIPE ?? "").toLowerCase()),
    },
    announcementsChannelId: optionalSnowflake(env, "ANNOUNCEMENTS_CHANNEL_ID"),
  };

  // ⚠️ A schedule that is on but cannot authenticate would fail every slot at
  // error level and look, from systemctl, exactly like one that is working.
  if (config.restartSchedule && !config.nitradoToken) {
    throw new Error("RESTART_SCHEDULE is on but NITRADO_TOKEN is unset — the bot cannot restart a server it cannot authenticate to.");
  }

  // ⚠️ Both halves ride on the restart tick's slots. Configured without the schedule
  // neither would ever fire at all — no error, no log, just a wipe that never happens.
  if ((config.truckWipe.events.length > 0 || config.truckWipe.rotation) && !config.restartSchedule) {
    throw new Error("TRUCK_WIPE_EVENTS or WEEKLY_VEHICLE_WIPE is set but RESTART_SCHEDULE is off — both run on the restart slots, so nothing would ever fire them.");
  }

  // ⚠️ Same reason as the truck wipe above: armbands ride the restart slots too,
  // so without the schedule nothing would ever write init.c and the feature
  // would be silently off.
  if (config.armbands && !config.restartSchedule) {
    throw new Error("CLAN_ARMBANDS is on but RESTART_SCHEDULE is off — armbands are written on the restart slots, so nothing would ever fire them.");
  }

  // ⚠️ Validated even when the wipe is off, so a typo surfaces at boot rather than
  // the morning someone finally sets TRUCK_WIPE_EVENTS.
  if (config.truckWipe.offHour === config.truckWipe.onHour) {
    throw new Error(`TRUCK_WIPE_OFF_HOUR and TRUCK_WIPE_ON_HOUR are both ${config.truckWipe.offHour} — that is an empty window, not a wipe.`);
  }
  // ⚠️ An event in both lists means the rotation loop overwrites the daily wipe's `0`
  // with `1` on every non-Monday slot — the rotation converges ALL five every slot
  // (see rotationActiveFor), so it always runs last and always wins. That silently
  // defeats the daily wipe for that event, with no error and no log.
  if (config.truckWipe.rotation) {
    const rotationEvents = new Set<string>(WEEKLY_WIPE_VEHICLES.map((v) => v.event));
    const overlap = config.truckWipe.events.filter((e) => rotationEvents.has(e));
    if (overlap.length > 0) {
      throw new Error(
        `TRUCK_WIPE_EVENTS names ${overlap.join(", ")}, which the weekly rotation already owns — ` +
        "remove them from TRUCK_WIPE_EVENTS; the rotation wipes them on its own schedule.",
      );
    }
  }

  return config;
}

/**
 * A UTC hour for the wipe window: even, 0-23, never silently defaulted.
 *
 * ⚠️ Only an ABSENT variable takes the default. A present-but-blank one throws:
 * blanking the line is a natural way to try to turn the feature off, and coercing
 * `""` to 0 would quietly move the wipe to midnight instead.
 *
 * ⚠️ Odd hours are refused because restarts land on even UTC hours only
 * (RESTART_PERIOD_MS = 2h, epoch-aligned), so an odd boundary is never a slot and
 * would never be the state a server actually boots into.
 */
function wipeHour(env: NodeJS.ProcessEnv, name: string, fallback: number): number {
  const raw = env[name];
  if (raw === undefined) return fallback;
  const trimmed = raw.trim();
  if (trimmed === "") throw new Error(`${name} is set but blank — remove the line to accept the default (${fallback}), or give it an even UTC hour.`);
  const n = Number(trimmed);
  if (!Number.isInteger(n) || n < 0 || n > 23) throw new Error(`${name} must be a whole UTC hour 0-23, got "${raw}".`);
  if (n % 2 !== 0) throw new Error(`${name}=${n} is an odd hour, but restarts only land on even UTC hours — that boundary is never a restart slot.`);
  return n;
}
