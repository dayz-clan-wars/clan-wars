/** ⚠️ Prefixes, anchored. A substring test matches `docs/deployment-notes.md`. */
const HOST_CONFIG_PREFIX = "deploy/";
const MIGRATIONS_PREFIX = "packages/db/migrations/";

export interface Changes {
  /** The release edits nginx or systemd config symlinked into /etc. */
  touchesHostConfig: boolean;
  /** The release adds or edits a drizzle migration. */
  touchesMigrations: boolean;
}

export function classifyChanges(paths: string[]): Changes {
  return {
    touchesHostConfig: paths.some((p) => p.startsWith(HOST_CONFIG_PREFIX)),
    touchesMigrations: paths.some((p) => p.startsWith(MIGRATIONS_PREFIX)),
  };
}
