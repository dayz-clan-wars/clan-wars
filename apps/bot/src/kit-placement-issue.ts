import type { Database } from "@factions/db";
import { boosterKitChallenges, identityLinks } from "@factions/db";
import { generateSequence } from "@factions/verification";
import { and, eq, isNull } from "drizzle-orm";

export type IssuedPlacementChallenge = { sequence: string[]; expiresAt: Date };

/**
 * Draw a placement challenge for this account, or null when the account is not
 * linked to a character.
 *
 * The challenge NAMES the linked character, and `kitPlacementTick` will only
 * ever advance it for that character — see the security boundary there. That
 * is why a three-emote sequence is enough, and why an unlinked account gets
 * nothing rather than a challenge anyone could satisfy.
 */
export async function issuePlacementChallenge(
  db: Database,
  deps: { discordId: string; now: Date; ttlMs: number; rng: () => number },
): Promise<IssuedPlacementChallenge | null> {
  const [link] = await db.select({ dayzId: identityLinks.dayzId })
    .from(identityLinks).where(eq(identityLinks.discordId, deps.discordId));
  if (!link) return null;

  const sequence = generateSequence(deps.rng);
  const expiresAt = new Date(deps.now.getTime() + deps.ttlMs);

  await db.transaction(async (tx) => {
    // ⚠️ Closes any previous open challenge for this account FIRST, in the
    // same transaction as the insert. `booster_kit_challenges_open_uniq` is a
    // partial unique index permitting exactly one open row per discord_id, so
    // without this a player who simply re-opens the placement page gets a
    // constraint violation instead of a fresh sequence. Doing it in one
    // transaction is what stops a crash between the two leaving the account
    // with no challenge at all.
    await tx.update(boosterKitChallenges).set({ closedAt: deps.now })
      .where(and(
        eq(boosterKitChallenges.discordId, deps.discordId),
        isNull(boosterKitChallenges.closedAt),
      ));
    await tx.insert(boosterKitChallenges).values({
      discordId: deps.discordId,
      targetDayzId: link.dayzId,
      sequence,
      issuedAt: deps.now,
      expiresAt,
    });
  });

  return { sequence, expiresAt };
}
