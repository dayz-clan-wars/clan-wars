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

/** Env in, config out. Takes the environment as an argument so failure paths are testable. */
export function loadConfig(env: NodeJS.ProcessEnv): BotConfig {
  return {
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
    dormantAfterMs: positiveInt(env, "BOT_DORMANT_AFTER_MS", 604_800_000),
    // 14 further days before the flag, tag and pole return to the 33-slot pool.
    disbandAfterDormantMs: positiveInt(env, "BOT_DISBAND_AFTER_DORMANT_MS", 1_209_600_000),
  };
}
