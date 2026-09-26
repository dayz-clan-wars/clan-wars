import { sql } from "drizzle-orm";
import type { Database } from "./client";

/**
 * Empty `referrals` between tests. Shared across every suite that writes a
 * referral (verification, roster, and later the bot and web) so there is one
 * copy of this workaround, not one per package.
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
    await tx.execute(sql`ALTER TABLE referrals DISABLE TRIGGER USER`);
    await tx.execute(sql`DELETE FROM referrals`);
    await tx.execute(sql`ALTER TABLE referrals ENABLE TRIGGER USER`);
  });
}
