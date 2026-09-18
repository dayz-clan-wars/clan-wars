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
  /**
   * Where release notes post, oldest first, one per tick. Undefined means it
   * is OFF: `release_announcements` rows keep queuing and nothing posts —
   * same degrade-not-refuse shape as `warLogChannelId`.
   */
  releaseChannelId: string | undefined;
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
   * Bare origin of the site — `https://dayzclanwars.com`. Every command
   * embed's title links here, the unrouted-interaction fallback in
   * `discord.ts` points a stale client or dead button at it, and the
   * ceremony DM does too.
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
  /** Truck wipe. `events` empty means off; the window is only meaningful when it is not. */
  truckWipe: { events: string[]; offHour: number; onHour: number; rotation: boolean };
  /**
   * Gates the raid-window flip on the restart slots. Off by default, same
   * reasoning as `achievementsTick`/`truckWipe`: the flip only takes effect
   * at a restart, so it rides on `restartSchedule` and is refused without it.
   */
  raidWindow: { enabled: boolean };
  /**
   * Where the raid-window tick posts its failure alert. Optional, gated like
   * `warLogChannelId` — unset means the alert falls back to an error-level
   * log line and nothing else, not a regression.
   */
  opsChannelId?: string;
  /** Required when `restartSchedule` is on; the same token the ingest worker uses. */
  nitradoToken: string | undefined;
  /** Where the weekly wipe notice posts. Unset = the wipe still happens, silently. */
  announcementsChannelId?: string;
  /**
   * ⚠️ Defaults TRUE. Real bans require explicitly setting `BAN_DRY_RUN`
   * to `"false"`. A ban row is always written and always transitions status;
   * only the Nitrado call is skipped, so a dry-run deployment still shows
   * exactly what would have happened. Anything that defaults to enforcing
   * (rather than to dry-run) is wrong — see `ban-tick.ts`.
   *
   * ⚠️ NEVER set this back to true while a ban is `applied`. The expire arm
   * then closes the row WITHOUT calling Nitrado, orphaning the list entry
   * permanently — and an orphaned account hash cannot be shed by renaming.
   */
  banDryRun: boolean;
  /** Gates the ban-reconciliation tick itself. Off by default, same reasoning as `achievementsTick`. */
  enforcementTick: boolean;
  /**
   * ⚠️ Independent of `banDryRun` on purpose. In production BAN_DRY_RUN is
   * already false, so the first PC ban is REAL the moment this is set. That
   * is a deliberate act on a chosen day, never a side effect of a deploy.
   */
  unlinkedPcBan: boolean;
  /**
   * The public #bans channel — enforced bans and unbans, announced. Undefined
   * means it is OFF: `ban_announcements` rows keep queuing (written whether or
   * not this is set) and nothing posts, same degrade-not-refuse shape as
   * `warLogChannelId`/`releaseChannelId`.
   */
  bansChannelId?: string;
};

function required(env: NodeJS.ProcessEnv, key: string): string {
  const v = env[key];
  if (!v) throw new Error(`${key} is not set. The bot cannot start without it.`);
  return v;
}

/** Plain base-10 digits only. See the comment in positiveInt for why. */
const DECIMAL_RE = /^\d+$/u;

/**
 * The largest delay `setInterval` actually honours.
 *
 * ⚠️ Node stores a timer delay in a signed 32-bit int. Past this it warns
 * (`TimeoutOverflowWarning`) and uses **1 ms** — so an extra-digits typo in
 * `BOT_TICK_INTERVAL_MS` does not slow the loop down, it turns it into a
 * database hammer firing a thousand times a second, while the value in `.env`
 * reads like a longer interval than intended. Exactly the "looks correctly
 * configured and is not" failure the comment in `positiveInt` is about.
 */
export const MAX_TIMER_MS = 2_147_483_647;

/**
 * `max` REFUSES rather than clamps, deliberately. Clamping would run an
 * interval the config does not say, which is the same silent-reinterpretation
 * this function already rejects `0x10` and `1e3` for. A bot that will not start
 * with a message naming the limit is the honest outcome.
 */
function positiveInt(env: NodeJS.ProcessEnv, key: string, fallback: number, max?: number): number {
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
  if (max !== undefined && n > max) {
    throw new Error(
      `${key} must be at most ${max}, got ${JSON.stringify(raw)}. ` +
      "A larger value is not a longer interval: setInterval truncates past " +
      `${MAX_TIMER_MS} and fires every 1 ms instead.`,
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
    // ⚠️ Capped: this one is a `setInterval` delay (discord.ts), not a duration
    // compared arithmetically like the four below it. See MAX_TIMER_MS.
    tickIntervalMs: positiveInt(env, "BOT_TICK_INTERVAL_MS", 10_000, MAX_TIMER_MS),
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
    releaseChannelId: optionalSnowflake(env, "RELEASE_CHANNEL_ID"),
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
    // (raise-tick's rebind_proposed link, every slash-command reply that
    // points at a page) builds
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
    nitradoToken: env.NITRADO_TOKEN?.trim() || undefined,
    truckWipe: {
      events: (env.TRUCK_WIPE_EVENTS ?? "").split(",").map((e) => e.trim()).filter((e) => e !== ""),
      offHour: wipeHour(env, "TRUCK_WIPE_OFF_HOUR", 8),
      onHour: wipeHour(env, "TRUCK_WIPE_ON_HOUR", 10),
      rotation: ["1", "true"].includes((env.WEEKLY_VEHICLE_WIPE ?? "").toLowerCase()),
    },
    raidWindow: { enabled: ["1", "true"].includes((env.RAID_WINDOW_TICK ?? "").toLowerCase()) },
    opsChannelId: optionalSnowflake(env, "OPS_CHANNEL_ID"),
    announcementsChannelId: optionalSnowflake(env, "ANNOUNCEMENTS_CHANNEL_ID"),
    // ⚠️ Trimmed and lowercased before the comparison. Without that, an operator
    // typing `FALSE` or ` false ` (either a reasonable thing to type) leaves the
    // raw string unequal to `"false"`, so `banDryRun` stays true — the SAFE
    // direction, but silently: the operator believes bans are now real, nothing
    // errors, and every ban stays a no-op against Nitrado. Only the exact,
    // normalized string `"false"` turns real bans on.
    banDryRun: (env.BAN_DRY_RUN ?? "true").trim().toLowerCase() !== "false",
    // Matches the `["1", "true"]` shape every other boolean flag in this file
    // uses (achievementsTick, restartSchedule, the truck-wipe flags below) —
    // `ENFORCEMENT_TICK=true` used to silently leave the tick off because only
    // the literal `"1"` was accepted.
    enforcementTick: ["1", "true"].includes((env.ENFORCEMENT_TICK ?? "").toLowerCase()),
    unlinkedPcBan: ["1", "true"].includes((env.UNLINKED_PC_BAN ?? "").toLowerCase()),
    bansChannelId: optionalSnowflake(env, "BANS_CHANNEL_ID"),
  };

  // ⚠️ A schedule that is on but cannot authenticate would fail every slot at
  // error level and look, from systemctl, exactly like one that is working.
  if (config.restartSchedule && !config.nitradoToken) {
    throw new Error("RESTART_SCHEDULE is on but NITRADO_TOKEN is unset — the bot cannot restart a server it cannot authenticate to.");
  }

  // ⚠️ Same failure shape as restartSchedule above, but worse: with BAN_DRY_RUN
  // already false and no token, every addBans/removeBans call throws, attempts
  // climbs on every retry, and three ticks later every pending row is
  // permanently `failed` — the apply query excludes `attempts >=
  // BAN_MAX_ATTEMPTS`, so nothing ever revisits them. A misconfigured restart
  // schedule costs one slot; a misconfigured enforcement tick destroys the
  // bans it was supposed to place, silently.
  if (config.enforcementTick && !config.nitradoToken) {
    throw new Error("ENFORCEMENT_TICK is on but NITRADO_TOKEN is unset — the bot cannot reach the ban list it cannot authenticate to.");
  }

  // ⚠️ pcBanTick only ever writes `bans` rows — banTick is what applies them
  // to Nitrado. Without enforcementTick on too, rows would pile up and never
  // be applied: a silent success from the operator's point of view.
  if (config.unlinkedPcBan && !config.enforcementTick) {
    throw new Error("UNLINKED_PC_BAN is on but ENFORCEMENT_TICK is off — ban rows would be written and never applied.");
  }

  // ⚠️ Both halves ride on the restart tick's slots. Configured without the schedule
  // neither would ever fire at all — no error, no log, just a wipe that never happens.
  if ((config.truckWipe.events.length > 0 || config.truckWipe.rotation) && !config.restartSchedule) {
    throw new Error("TRUCK_WIPE_EVENTS or WEEKLY_VEHICLE_WIPE is set but RESTART_SCHEDULE is off — both run on the restart slots, so nothing would ever fire them.");
  }
  // ⚠️ Same failure shape as the truck wipe's check just above: the flip only
  // takes effect when the server restarts, and restarts come from the restart
  // slots. On without RESTART_SCHEDULE would write a file nobody ever reloads —
  // the silent no-op class this repo refuses to ship.
  if (config.raidWindow.enabled && !config.restartSchedule) {
    throw new Error("RAID_WINDOW_TICK is on but RESTART_SCHEDULE is off — the flip only takes effect at a restart, so nothing would ever apply it.");
  }
  // ⚠️ Fatal, unlike OPS_CHANNEL_ID below: the ops alert has a real degrade (an
  // error-level log line, same as WAR_LOG_CHANNEL_ID unset), but the advance/open/
  // close notices are the player-facing point of this feature — with no channel to
  // post them to, this is misconfigured, not merely degraded. It also closes a
  // write-order hazard: gating the tick on `announcePoster` being present instead
  // would either skip the tick silently (so a refused flip raises no alert either,
  // since that check also guards the ops path) or, if the gate were dropped, let a
  // no-op "post" return successfully and have postOnce's post-first-row-second
  // order write an announcements row claiming the message went out when it did not.
  if (config.raidWindow.enabled && !config.announcementsChannelId) {
    throw new Error("RAID_WINDOW_TICK is on but ANNOUNCEMENTS_CHANNEL_ID is unset — the feature posts player-facing advance/open/close notices, and with no channel to post them to it is misconfigured, not merely degraded.");
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
