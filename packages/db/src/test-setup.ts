import { sql } from "drizzle-orm";
import { createClient } from "./client.js";
import { packageNameAt, testDatabaseNameFor, TEST_DATABASE_PREFIX } from "./test-database-url.js";

/** Postgres `duplicate_database`. Two packages racing the same CREATE. */
const DUPLICATE_DATABASE = "42P04";

/**
 * Vitest `globalSetup`: make sure this package's own test database exists.
 *
 * Referenced from every DB-backed package's `vitest.config.ts`. It creates the
 * database and nothing else — the suites themselves already call
 * `runMigrations` in their `beforeAll`/`beforeEach`, and drizzle's migrator is
 * idempotent against its journal table. That split is deliberate: the database
 * is reused across runs (creating one per run costs seconds on every suite),
 * but its schema is brought up to date by every single run, so a reused
 * database can never be stale.
 *
 * ⚠️ The one case reuse cannot cover is an EDITED migration — drizzle records
 * that it already applied `0007` and will not re-run the new contents. Set
 * `TEST_DATABASE_FRESH=1` to drop and recreate, which is the correct response
 * to editing a migration rather than adding one.
 *
 * ⚠️ Reaches Postgres through `createClient` rather than importing `postgres`
 * directly. This file is loaded by five packages' vitest configs, and only
 * `@factions/db` has `postgres` in its dependencies — under pnpm's strict
 * layout a bare `import postgres from "postgres"` here fails to resolve for
 * every other one. `@factions/db` and `drizzle-orm` are dependencies of all of
 * them.
 */
export default async function setup(): Promise<void> {
  const base = process.env.TEST_DATABASE_URL;
  if (!base) {
    throw new Error(
      "TEST_DATABASE_URL is not set, so the per-package test database cannot be " +
      "created. Start the database and export it, e.g.\n" +
      '  export TEST_DATABASE_URL="postgres://factions:factions@localhost:5434/factions"',
    );
  }

  const name = testDatabaseNameFor(packageNameAt(process.cwd()));

  // ⚠️ Connected to the base URL's own database, NOT the one being created —
  // Postgres cannot create a database from inside itself. `sql.raw` is safe
  // here and unavoidable: an identifier cannot be a bind parameter, and
  // `testDatabaseNameFor` has already reduced the name to [a-z0-9_] behind a
  // fixed prefix.
  const admin = createClient(base);
  try {
    if (process.env.TEST_DATABASE_FRESH === "1") {
      // ⚠️ Re-checked at the point of the drop, even though
      // `testDatabaseNameFor` already guarantees it. This is the only DROP
      // DATABASE in the repository and the cost of it being wrong is somebody's
      // production data, so it does not trust a guarantee made two functions away.
      if (!name.startsWith(TEST_DATABASE_PREFIX)) {
        throw new Error(`refusing to drop ${name}: not a ${TEST_DATABASE_PREFIX}* database`);
      }
      await admin.execute(sql.raw(`drop database if exists "${name}" with (force)`));
    }

    const existing = await admin.execute(sql`select 1 from pg_database where datname = ${name}`);
    if (existing.length === 0) {
      try {
        await admin.execute(sql.raw(`create database "${name}"`));
      } catch (err) {
        // Another package's setup won the race. Both wanted the same outcome.
        if ((err as { code?: string }).code !== DUPLICATE_DATABASE) throw err;
      }
    }
  } finally {
    // ⚠️ Without this the vitest process keeps an open pool and hangs after the
    // last test file finishes — a green run that never exits.
    await admin.$client.end();
  }
}
