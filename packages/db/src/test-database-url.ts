/**
 * The URL of the Postgres instance the integration tests run against.
 *
 * ⚠️ This THROWS when TEST_DATABASE_URL is unset — deliberately. The previous
 * `describe.skipIf(!URL)` pattern made every database-backed suite vanish on a
 * CI runner or fresh clone that had not exported the variable, and the run
 * still exited 0. A missing test database is a broken environment, not a
 * reason to report green: fail loudly instead.
 */
export function requireTestDatabaseUrl(): string {
  const url = process.env.TEST_DATABASE_URL;
  if (!url) {
    throw new Error(
      "TEST_DATABASE_URL is not set. The database-backed test suites cannot run " +
      "without it, and skipping them would hide every integration regression " +
      "behind a green run. Start the database and export it, e.g.\n" +
      '  export TEST_DATABASE_URL="postgres://factions:factions@localhost:5434/factions"',
    );
  }
  return url;
}
