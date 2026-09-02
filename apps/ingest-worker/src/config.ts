export type WorkerConfig = {
  databaseUrl: string;
  nitradoToken: string;
  intervalSeconds: number;
  backfillBudget: number;
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
    // ⚠️ There is deliberately no MISSION_CUSTOM_DIR here any more. The supply
    // file's destination is per SERVER, not per process — the path embeds the
    // gameserver's username — so it is resolved from each server's own Nitrado
    // service each sweep (NitradoClient.missionCustomDir). One env value
    // applied to every server was correct for exactly one of them and
    // silently wrong for the rest.
  };
}
