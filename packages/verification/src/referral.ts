import type { Database } from "@factions/db";
import { identityLinks, referrals, type ReferralSource } from "@factions/db";
import { eq, sql } from "drizzle-orm";

type Tx = Parameters<Parameters<Database["transaction"]>[0]>[0];
type Reader = Database | Tx;

/**
 * Why a referral was not recorded. "not-linked" is only ever returned by the
 * write: the pre-check runs before the referred player has linked.
 */
export type ReferralRefusal = "already-referred" | "self" | "referrer-not-linked" | "loop" | "not-linked";

/** Would naming `referrer` put `referred` in their own chain of referrers? */
async function makesLoop(db: Reader, referredDiscordId: string, referrerDiscordId: string): Promise<boolean> {
  // UNION, not UNION ALL: a cycle already in the table (only reachable by an
  // operator dropping the trigger) must end the walk instead of spinning it.
  const rows = await db.execute(sql`
    WITH RECURSIVE chain(d) AS (
      SELECT referrer_discord_id FROM referrals WHERE referred_discord_id = ${referrerDiscordId}
      UNION
      SELECT r.referrer_discord_id FROM referrals r JOIN chain c ON r.referred_discord_id = c.d
    )
    SELECT 1 FROM chain WHERE d = ${referredDiscordId} LIMIT 1`);
  return rows.length > 0;
}

/**
 * The friendly refusal before a challenge is issued or a referral is asked
 * for. Read-only and unlocked, so it is advice, not enforcement:
 * `recordReferralTx` re-checks everything under its lock.
 *
 * The referred player need not be linked yet, and "already-referred" is
 * checked regardless: a referral outlives an unlink, so an unlinked player
 * who was referred before cannot name someone new by relinking.
 */
export async function checkReferral(
  db: Reader,
  a: { referredDiscordId: string; referrerDiscordId: string },
): Promise<null | Exclude<ReferralRefusal, "not-linked">> {
  if (a.referredDiscordId === a.referrerDiscordId) return "self";
  const [existing] = await db.select({ d: referrals.referredDiscordId }).from(referrals)
    .where(eq(referrals.referredDiscordId, a.referredDiscordId));
  if (existing) return "already-referred";
  const [link] = await db.select({ d: identityLinks.discordId }).from(identityLinks)
    .where(eq(identityLinks.discordId, a.referrerDiscordId));
  if (!link) return "referrer-not-linked";
  return (await makesLoop(db, a.referredDiscordId, a.referrerDiscordId)) ? "loop" : null;
}

/**
 * The only write to `referrals` (spec §4). Runs inside the caller's
 * transaction, so a link-time referral commits or rolls back with the link.
 *
 * A refusal is a return value, never a throw: the caller decides what it
 * means, and `completeChallenge` must never lose a link over one.
 *
 * ⚠️ The advisory lock serialises every referral write: without it, A→B and
 * B→A in flight together both pass the loop walk and both insert, and the
 * table holds a loop no reader expects. Referrals are rare, so one global
 * lock costs nothing.
 */
export async function recordReferralTx(
  tx: Tx,
  a: { referredDiscordId: string; referrerDiscordId: string; source: ReferralSource; at: Date },
): Promise<"recorded" | ReferralRefusal> {
  await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext('referrals'))`);
  const [me] = await tx.select({ d: identityLinks.discordId }).from(identityLinks)
    .where(eq(identityLinks.discordId, a.referredDiscordId));
  if (!me) return "not-linked";
  if (a.referredDiscordId === a.referrerDiscordId) return "self";
  const [referrer] = await tx.select({ dayzId: identityLinks.dayzId }).from(identityLinks)
    .where(eq(identityLinks.discordId, a.referrerDiscordId));
  if (!referrer) return "referrer-not-linked";
  if (await makesLoop(tx, a.referredDiscordId, a.referrerDiscordId)) return "loop";
  // ⚠️ .returning() decides the outcome, not a pre-read: the primary key is
  // what makes "one referrer per player" true, and ON CONFLICT DO NOTHING
  // raises nothing when it loses.
  const inserted = await tx.insert(referrals).values({
    referredDiscordId: a.referredDiscordId, referrerDiscordId: a.referrerDiscordId,
    referrerDayzId: referrer.dayzId, source: a.source, createdAt: a.at,
  }).onConflictDoNothing().returning({ d: referrals.referredDiscordId });
  return inserted.length > 0 ? "recorded" : "already-referred";
}
