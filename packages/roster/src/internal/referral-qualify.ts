import { and, asc, eq, inArray, isNull, notExists } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { identityLinks, playerSessions, referralQualifications, referrals, type Database } from "@factions/db";
import { qualifiedAt, type SessionSpan } from "@factions/domain";

/**
 * Record every referral that has newly qualified (spec 2026-09-27-referral-leaderboard §2).
 * Returns how many were written.
 *
 * Only the referred player's CURRENT link is consulted: an unlinked referred
 * player cannot qualify, but one who already has is kept (the table is permanent).
 * Each qualification is its own insert, `ON CONFLICT DO NOTHING`, so a run that
 * fails partway, or two runs racing, write each row at most once.
 *
 * ⚠️ One character, one qualification: a referral whose referred player's current
 * character already backs a qualification (through any Discord account) is never
 * qualified. Without this, one 2h+ character relinked across Discord alts, each
 * naming the same referrer, farmed a referral per cycle. The NOT EXISTS below is
 * the check; the partial unique index on `referred_dayz_id` plus ON CONFLICT DO
 * NOTHING is the race guard when two runs pass it at once.
 */
export async function qualifyReferralsDb(db: Database, now: Date): Promise<number> {
  const backed = alias(referralQualifications, "backed");
  const pending = await db.select({
    referredDiscordId: referrals.referredDiscordId, referrerDiscordId: referrals.referrerDiscordId,
    createdAt: referrals.createdAt, dayzId: identityLinks.dayzId,
  }).from(referrals)
    .innerJoin(identityLinks, eq(identityLinks.discordId, referrals.referredDiscordId))
    .leftJoin(referralQualifications, eq(referralQualifications.referredDiscordId, referrals.referredDiscordId))
    .where(and(
      isNull(referralQualifications.referredDiscordId),
      notExists(db.select({ one: backed.referredDiscordId }).from(backed).where(eq(backed.referredDayzId, identityLinks.dayzId))),
    ));
  if (pending.length === 0) return 0;

  const sessions = await db.select({ dayzId: playerSessions.dayzId, connectedAt: playerSessions.connectedAt, disconnectedAt: playerSessions.disconnectedAt })
    .from(playerSessions)
    .where(inArray(playerSessions.dayzId, pending.map((p) => p.dayzId)))
    .orderBy(asc(playerSessions.connectedAt));
  const byPlayer = new Map<string, SessionSpan[]>();
  for (const s of sessions) {
    const list = byPlayer.get(s.dayzId) ?? [];
    list.push({ connectedAt: s.connectedAt, disconnectedAt: s.disconnectedAt });
    byPlayer.set(s.dayzId, list);
  }

  let written = 0;
  for (const p of pending) {
    const when = qualifiedAt(byPlayer.get(p.dayzId) ?? [], p.createdAt, now);
    if (when === null) continue;
    const rows = await db.insert(referralQualifications)
      .values({ referredDiscordId: p.referredDiscordId, referrerDiscordId: p.referrerDiscordId, referredDayzId: p.dayzId, qualifiedAt: when })
      .onConflictDoNothing().returning({ id: referralQualifications.referredDiscordId });
    written += rows.length;
  }
  return written;
}
