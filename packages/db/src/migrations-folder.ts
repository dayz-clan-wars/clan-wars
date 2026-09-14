import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

/**
 * Where this package's migrations live, resolved from this file rather than
 * from the caller's cwd — `pnpm db:migrate` runs from the repo root and the
 * test suites run from the package root.
 *
 * Its own module so `migrate.ts` (which pulls in drizzle's migrator) and
 * `migration-plan.ts` (which must stay pure and cheap) can share it without
 * either importing the other.
 */
export const MIGRATIONS_FOLDER = join(dirname(fileURLToPath(import.meta.url)), "..", "migrations");
