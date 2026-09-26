import type { Database } from "@factions/db";
import { identityLinks, players, referrals } from "@factions/db";
import { recordReferralTx, type ReferralRefusal } from "@factions/verification";
import { eq } from "drizzle-orm";
import { resolveGamertagLink } from "./writes";

/** Why a gamertag typed as a referrer was refused, beyond the write's own reasons. */
export type ReferrerRefusal = ReferralRefusal | "unknown-referrer" | "ambiguous-referrer";

export type AddReferrerOutcome =
  | { kind: "recorded"; referrerGamertag: string }
  /** `referrerGamertag` on "already-referred" is the EXISTING referrer's, not the one just typed. */
  | { kind: "refused"; reason: ReferrerRefusal; referrerGamertag?: string };

export type ReferralsView = { referredBy: { gamertag: string } | null; brought: { gamertag: string | null }[] };

/** Resolve a typed gamertag to a linked player, for naming a referrer. */
export async function resolveReferrer(
  db: Database, gamertag: string,
): Promise<{ discordId: string } | "unknown-referrer" | "ambiguous-referrer"> {
  const r = await resolveGamertagLink(db, gamertag.trim());
  if (r === "ambiguous-gamertag") return "ambiguous-referrer";
  return r ? { discordId: r.discordId } : "unknown-referrer";
}

/**
 * The gamertag to show for a Discord id that may have unlinked since a
 * referral naming them was recorded: the current link's gamertag, else the
 * player's own last-seen gamertag from the referral's own snapshot
 * (`referrer_dayz_id`) — a referral has no foreign key to `identity_links`
 * and outlives it.
 */
async function currentGamertag(db: Database, discordId: string): Promise<string> {
  const [link] = await db.select({ gamertag: identityLinks.gamertag }).from(identityLinks)
    .where(eq(identityLinks.discordId, discordId));
  if (link) return link.gamertag;
  const [row] = await db.select({ dayzId: referrals.referrerDayzId }).from(referrals)
    .where(eq(referrals.referrerDiscordId, discordId)).limit(1);
  if (row) {
    const [player] = await db.select({ gamertag: players.gamertag }).from(players).where(eq(players.dayzId, row.dayzId));
    if (player) return player.gamertag;
  }
  return discordId;
}

/** Add a referrer to an already-linked (or not-yet-linked-but-known) player, by gamertag. */
export async function addReferrerDb(
  db: Database, now: Date, discordId: string, gamertag: string, source: "later_bot" | "later_site",
): Promise<AddReferrerOutcome> {
  const ref = await resolveReferrer(db, gamertag);
  if (typeof ref === "string") return { kind: "refused", reason: ref };
  const r = await db.transaction((tx) => recordReferralTx(tx, {
    referredDiscordId: discordId, referrerDiscordId: ref.discordId, source, at: now,
  }));
  if (r === "recorded") return { kind: "recorded", referrerGamertag: await currentGamertag(db, ref.discordId) };
  if (r === "already-referred") {
    return { kind: "refused", reason: r, referrerGamertag: (await referralsForDb(db, discordId)).referredBy?.gamertag };
  }
  return { kind: "refused", reason: r };
}

/** Who this player was referred by (current gamertag, falling back to the last seen one), null if nobody. */
export async function referredByFor(db: Database, discordId: string): Promise<{ gamertag: string } | null> {
  const [row] = await db.select({ referrerDiscordId: referrals.referrerDiscordId }).from(referrals)
    .where(eq(referrals.referredDiscordId, discordId));
  return row ? { gamertag: await currentGamertag(db, row.referrerDiscordId) } : null;
}

/** Who this player referred, and who referred them (spec §2). */
export async function referralsForDb(db: Database, discordId: string): Promise<ReferralsView> {
  const referredBy = await referredByFor(db, discordId);
  const broughtRows = await db.select({ referredDiscordId: referrals.referredDiscordId }).from(referrals)
    .where(eq(referrals.referrerDiscordId, discordId));
  const brought = await Promise.all(broughtRows.map(async (row) => {
    const [link] = await db.select({ gamertag: identityLinks.gamertag }).from(identityLinks)
      .where(eq(identityLinks.discordId, row.referredDiscordId));
    return { gamertag: link ? link.gamertag : null };
  }));
  return { referredBy, brought };
}

/** Same as `referralsForDb`, but by the profile's gamertag. Null when that player is not currently linked. */
export async function referralsForGamertagDb(db: Database, gamertag: string): Promise<ReferralsView | null> {
  const link = await resolveGamertagLink(db, gamertag.trim());
  if (!link || link === "ambiguous-gamertag") return null;
  return referralsForDb(db, link.discordId);
}
