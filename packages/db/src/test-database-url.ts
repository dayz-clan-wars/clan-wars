import { readFileSync } from "node:fs";
import { dirname, join, parse as parsePath } from "node:path";

/**
 * Prefix on every per-package test database.
 *
 * ⚠️ Load-bearing, not cosmetic. It is what makes it impossible for a derived
 * name to collide with `factions` (the old shared test database) or
 * `factions_live` (production). Before per-package databases, a
 * `TEST_DATABASE_URL` typo pointed a suite at live data and the next
 * `pnpm test` truncated it; now the base URL contributes only the server, and
 * the database name is always derived. Do not make this configurable.
 */
export const TEST_DATABASE_PREFIX = "factions_test_";

/**
 * The database a given workspace package's suites own.
 *
 * One database per package is the fix for inbox item 21: every app pointed at
 * the single `factions` database and truncated shared tables underneath its
 * neighbours, so `pnpm -r test` failed in `apps/projector` and
 * `apps/ingest-worker` while both passed in isolation. The truncations were
 * never the bug — sharing a namespace was.
 */
export function testDatabaseNameFor(packageName: string): string {
  // Drop an npm scope: `@factions/bot` and a hypothetical `@other/bot` would
  // collide, but this workspace has exactly one scope, and carrying it would
  // put an `@` and a `/` into an identifier for no benefit.
  const bare = packageName.replace(/^@[^/]*\//u, "");
  const sanitised = bare.toLowerCase().replace(/[^a-z0-9]+/gu, "_").replace(/^_+|_+$/gu, "");

  // ⚠️ Throw rather than fall back. A name that sanitises to nothing would
  // collapse every package onto one database, which is precisely the failure
  // this function exists to prevent — and it would do it silently, looking
  // like a correctly configured run.
  if (sanitised === "") {
    throw new Error(
      `Cannot derive a test database from package name ${JSON.stringify(packageName)}: ` +
      "it contains no characters usable in an identifier.",
    );
  }
  return `${TEST_DATABASE_PREFIX}${sanitised}`;
}

/**
 * The base URL's server, with this package's own database substituted.
 *
 * The base contributes host, port, credentials and query parameters. Whatever
 * database it names is DISCARDED — see TEST_DATABASE_PREFIX.
 */
export function testDatabaseUrlFor(baseUrl: string, packageName: string): string {
  let url: URL;
  try {
    url = new URL(baseUrl);
  } catch {
    throw new Error(
      `TEST_DATABASE_URL is not a valid URL: ${JSON.stringify(baseUrl)}. ` +
      'Expected something like "postgres://factions:factions@localhost:5434/factions".',
    );
  }
  url.pathname = `/${testDatabaseNameFor(packageName)}`;
  return url.toString();
}

/**
 * The name in the nearest `package.json` at or above `from`.
 *
 * Read from the filesystem rather than from `npm_package_name` because that
 * variable exists only under a package-manager script. Vitest runs with the
 * package root as its cwd under turbo, under `pnpm --filter`, and under a bare
 * `npx vitest`, so the file is the reliable signal and the env var is not.
 */
export function packageNameAt(from: string): string {
  let dir = from;
  for (;;) {
    try {
      const raw = readFileSync(join(dir, "package.json"), "utf8");
      const name: unknown = (JSON.parse(raw) as { name?: unknown }).name;
      if (typeof name === "string" && name !== "") return name;
    } catch {
      // No package.json here, or an unreadable one: keep walking up.
    }
    const parent = dirname(dir);
    if (parent === dir || dir === parsePath(dir).root) break;
    dir = parent;
  }
  throw new Error(
    `No package.json with a name found at or above ${from}. ` +
    "The test database is derived from the package name, so it cannot be resolved without one.",
  );
}

/**
 * The URL of the Postgres database THIS package's integration tests own.
 *
 * ⚠️ This THROWS when TEST_DATABASE_URL is unset — deliberately. The previous
 * `describe.skipIf(!URL)` pattern made every database-backed suite vanish on a
 * CI runner or fresh clone that had not exported the variable, and the run
 * still exited 0. A missing test database is a broken environment, not a
 * reason to report green: fail loudly instead.
 *
 * ⚠️ The database TEST_DATABASE_URL names is IGNORED. Only its server and
 * credentials are used; the database is derived per package so no two suites
 * share a namespace. The per-package database is created by the shared
 * `globalSetup` in `./test-setup.js`, which every DB-backed package's
 * `vitest.config.ts` must reference — without it the suite fails to connect
 * rather than silently falling back to a shared database.
 */
export function requireTestDatabaseUrl(cwd: string = process.cwd()): string {
  const base = process.env.TEST_DATABASE_URL;
  if (!base) {
    throw new Error(
      "TEST_DATABASE_URL is not set. The database-backed test suites cannot run " +
      "without it, and skipping them would hide every integration regression " +
      "behind a green run. Start the database and export it, e.g.\n" +
      '  export TEST_DATABASE_URL="postgres://factions:factions@localhost:5434/factions"\n' +
      "Only its host, port and credentials are used — each package gets its own " +
      `${TEST_DATABASE_PREFIX}* database.`,
    );
  }
  return testDatabaseUrlFor(base, packageNameAt(cwd));
}
