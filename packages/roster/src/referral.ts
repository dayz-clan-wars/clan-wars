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

/** `referredBy.gamertag` and `brought[].gamertag` are null when no name is known any more; never a Discord id. */
export type ReferralsView = { referredBy: { gamertag: string | null } | null; brought: { gamertag: string | null }[] };

/** Resolve a typed gamertag to a linked player, for naming a referrer. */
export async function resolveReferrer(
  db: Database, gamertag: string,
): Promise<{ discordId: string } | "unknown-referrer" | "ambiguous-referrer"> {
  const r = await resolveGamertagLink(db, gamertag.trim());
  if (r === "ambiguous-gamertag") return "ambiguous-referrer";
  return r ? { discordId: r.discordId } : "unknown-referrer";
}

/**
 * The gamertag to show for a referrer who may have unlinked since the
 * referral naming them was recorded: their current link's gamertag, else the
 * last-seen gamertag of the character THIS referral snapshotted
 * (`referrer_dayz_id`) — a referral has no foreign key to `identity_links`
 * and outlives it. Null when neither is known: a Discord id is never shown in
 * its place, since it is not a name and `/players/{it}` is a 404.
 */
async function currentGamertag(db: Database, discordId: string, referrerDayzId: string): Promise<string | null> {
  const [link] = await db.select({ gamertag: identityLinks.gamertag }).from(identityLinks)
    .where(eq(identityLinks.discordId, discordId));
  if (link) return link.gamertag;
  const [player] = await db.select({ gamertag: players.gamertag }).from(players).where(eq(players.dayzId, referrerDayzId));
  return player?.gamertag ?? null;
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
  // The referrer was linked a moment ago (recordReferralTx checked), so this
  // is their link's gamertag; the typed name is the fallback, never an id.
  if (r === "recorded") return { kind: "recorded", referrerGamertag: (await referredByFor(db, discordId))?.gamertag ?? gamertag.trim() };
  if (r === "already-referred") {
    return { kind: "refused", reason: r, referrerGamertag: (await referredByFor(db, discordId))?.gamertag ?? undefined };
  }
  return { kind: "refused", reason: r };
}

/**
 * Who this player was referred by (current gamertag, falling back to the last
 * seen one), null if nobody. `gamertag` is null when the referrer has
 * unlinked and no name for them is known: callers show the referral but
 * name and link nobody.
 */
export async function referredByFor(db: Database, discordId: string): Promise<{ gamertag: string | null } | null> {
  const [row] = await db.select({ referrerDiscordId: referrals.referrerDiscordId, referrerDayzId: referrals.referrerDayzId })
    .from(referrals).where(eq(referrals.referredDiscordId, discordId));
  return row ? { gamertag: await currentGamertag(db, row.referrerDiscordId, row.referrerDayzId) } : null;
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

/**
 * Same as `referralsForDb`, but for the character a public profile shows.
 * Keyed by the profile's own `dayzId`, not its gamertag: two links can share
 * a gamertag case-insensitively, and the profile (`resolvePlayer`) has
 * already chosen between them. Null when that character is not linked now.
 */
export async function referralsForDayzIdDb(db: Database, dayzId: string): Promise<ReferralsView | null> {
  const [link] = await db.select({ discordId: identityLinks.discordId }).from(identityLinks)
    .where(eq(identityLinks.dayzId, dayzId));
  return link ? referralsForDb(db, link.discordId) : null;
}
