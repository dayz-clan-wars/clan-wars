import { sql } from "drizzle-orm";
import type { Database } from "@factions/db";

/**
 * Empty `referrals` between tests. ⚠️ Not in the suites' `truncate ... cascade`
 * list: the permanence trigger (migration 0054) rejects TRUNCATE and DELETE,
 * and no foreign key cascades into it. Disable the trigger for this cleanup only.
 */
export async function clearReferrals(db: Database) {
  await db.execute(sql`ALTER TABLE referrals DISABLE TRIGGER USER`);
  await db.execute(sql`DELETE FROM referrals`);
  await db.execute(sql`ALTER TABLE referrals ENABLE TRIGGER USER`);
}
