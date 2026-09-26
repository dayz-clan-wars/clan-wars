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
