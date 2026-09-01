export type WorkerConfig = {
  databaseUrl: string;
  nitradoToken: string;
  intervalSeconds: number;
  backfillBudget: number;
  missionCustomDir: string;
};

function required(env: NodeJS.ProcessEnv, key: string): string {
  const v = env[key];
  if (!v) throw new Error(`${key} is required.`);
  return v;
}

/** Plain decimal digits only, with an optional minimum. */
const DECIMAL_RE = /^\d+$/u;

function intAtLeast(env: NodeJS.ProcessEnv, key: string, fallback: number, min: number): number {
  const raw = env[key];
  if (raw === undefined) return fallback;
  // ⚠️ Number() accepts "1e3", " 10 " and "0x10", so a typo'd interval would
  // run this loop at a cadence nobody configured while looking correct. Same
  // reasoning as apps/bot/src/config.ts.
  const n = DECIMAL_RE.test(raw) ? Number(raw) : Number.NaN;
  if (!Number.isSafeInteger(n) || n < min) {
    throw new Error(`${key} must be an integer >= ${min} in plain decimal digits, got ${JSON.stringify(raw)}.`);
  }
  return n;
}

export function loadConfig(env: NodeJS.ProcessEnv): WorkerConfig {
  return {
    databaseUrl: required(env, "DATABASE_URL"),
    nitradoToken: required(env, "NITRADO_TOKEN"),
    intervalSeconds: intAtLeast(env, "INGEST_INTERVAL_SECONDS", 60, 1),
    // Zero is meaningful: process only the live file this tick.
    backfillBudget: intAtLeast(env, "ADM_BACKFILL_BUDGET", 15, 0),
    // No sensible default: a wrong or absent path uploads the supply file
    // where the server never reads it, and nothing would report that.
    //
    // ⚠️ SINGLE-SERVER ONLY. This is ONE process-wide value applied to every
    // server the sweep visits, but the path is service-specific — the live
    // value embeds a Nitrado service id
    // (`/games/ni<serviceid>_4/ftproot/...`). With one active server that is
    // correct. With two, the second server's file is uploaded into the FIRST
    // service's directory, and if that path exists the upload SUCCEEDS
    // silently into a folder the second server never reads: no error, hash
    // advances, supplies never appear. Making this per-server means a
    // `servers` column, which is a schema change. See PLAN-3-INBOX item 23.
    missionCustomDir: required(env, "MISSION_CUSTOM_DIR"),
  };
}
