import { sql } from "drizzle-orm";
import type { Database } from "./client";
import { TEST_DATABASE_PREFIX } from "./test-database-url";

/**
 * Refuses any database whose name does not start with `TEST_DATABASE_PREFIX`.
 *
 * Factored out of `clearReferrals` so the name check itself can be unit tested
 * without needing a live connection to a non-test database — connecting to one
 * on purpose, from a test, is exactly the mistake this guard exists to prevent.
 */
export function assertTestDatabaseName(name: string): void {
  if (!name.startsWith(TEST_DATABASE_PREFIX)) {
    throw new Error(
      `clearReferrals refuses to run against database ${JSON.stringify(name)}: ` +
      `its name does not start with ${JSON.stringify(TEST_DATABASE_PREFIX)}. ` +
      "This helper disables the referrals permanence trigger and deletes every " +
      "row; it must never run against anything but a per-package test database.",
    );
  }
}

/**
 * Empty `referrals` between tests. Shared across every suite that writes a
 * referral (verification, roster, and later the bot and web) so there is one
 * copy of this workaround, not one per package.
 *
 * ⚠️ Refuses any database that is not a per-package test database — it reads
 * `current_database()` inside the transaction and throws unless the name
 * starts with `TEST_DATABASE_PREFIX`, before it ever touches the trigger.
 * Every consumer of `@factions/db` (apps/bot, apps/web) can import this
 * function, and nothing else stops it running against `factions_live`.
 *
 * ⚠️ Not part of any suite's `truncate ... cascade` list: the permanence
 * trigger (migration 0054) rejects TRUNCATE and DELETE, and no foreign key
 * cascades into it. Disable the trigger for this cleanup only, and do the
 * whole disable/delete/enable inside one transaction — otherwise a DELETE
 * that fails partway (a lock timeout, say) could leave the trigger disabled
 * for every write that runs after it, in the same suite or the next one.
 */
export async function clearReferrals(db: Database): Promise<void> {
  await db.transaction(async (tx) => {
    const rows = await tx.execute(sql`SELECT current_database()`);
    const name = (rows[0] as { current_database?: string } | undefined)?.current_database ?? "";
    assertTestDatabaseName(name);
    await tx.execute(sql`ALTER TABLE referrals DISABLE TRIGGER USER`);
    await tx.execute(sql`DELETE FROM referrals`);
    await tx.execute(sql`ALTER TABLE referrals ENABLE TRIGGER USER`);
  });
}
