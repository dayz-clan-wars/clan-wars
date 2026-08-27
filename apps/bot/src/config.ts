export type BotConfig = {
  token: string;
  applicationId: string;
  guildId: string;
  databaseUrl: string;
  tickIntervalMs: number;
  challengeTtlMs: number;
};

function required(env: NodeJS.ProcessEnv, key: string): string {
  const v = env[key];
  if (!v) throw new Error(`${key} is not set. The bot cannot start without it.`);
  return v;
}

function positiveInt(env: NodeJS.ProcessEnv, key: string, fallback: number): number {
  const raw = env[key];
  if (raw === undefined || raw === "") return fallback;
  const n = Number(raw);
  // A silently-defaulted interval is a bot that looks configured and is not.
  if (!Number.isInteger(n) || n <= 0) {
    throw new Error(`${key} must be a positive integer, got ${JSON.stringify(raw)}.`);
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
    challengeTtlMs: positiveInt(env, "BOT_CHALLENGE_TTL_MS", 600_000),
  };
}
