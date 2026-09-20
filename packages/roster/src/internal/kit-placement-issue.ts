import type { Database } from "@factions/db";
import { boosterKitChallenges, identityLinks } from "@factions/db";
import { generateSequence } from "@factions/verification";
import { and, eq, isNull } from "drizzle-orm";

export type IssuedPlacementChallenge = { id: number; sequence: string[]; expiresAt: Date };

/**
 * Draw a placement challenge for this account, or null when the account is not
 * linked to a character.
 *
 * The challenge NAMES the linked character, and `kitPlacementTick` will only
 * ever advance it for that character — see the security boundary there. That
 * is why a three-emote sequence is enough, and why an unlinked account gets
 * nothing rather than a challenge anyone could satisfy.
 *
 * ⚠️ The dayz_id is pinned AT ISSUE TIME and never re-read. If the booster
 * unlinks while the challenge is open and a different Discord account links
 * that same character, that third party's emotes would set the FIRST
 * booster's spot. Unexploitable in practice — the sequence is drawn at random
 * and shown only to the account that asked for it, so the new holder does not
 * know which three emotes to perform — and the blast radius is one booster's
 * own kit landing somewhere they did not choose. Left as-is rather than
 * re-resolving the link on every emote, which would cost a lookup per event
 * in the tick's hot path. Revisit if a placement is ever worth more than the
 * clothing it drops.
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

  // ⚠️ Assigned inside the transaction and read after it, never widened to a
  // second SELECT: the partial unique index permits one open row per account,
  // so "the newest open row" would be right today and wrong the moment two
  // draws race. The id the INSERT itself returned is the one that was issued.
  let id = 0;
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
    const [row] = await tx.insert(boosterKitChallenges).values({
      discordId: deps.discordId,
      targetDayzId: link.dayzId,
      sequence,
      issuedAt: deps.now,
      expiresAt,
    }).returning({ id: boosterKitChallenges.id });
    id = row!.id;
  });

  return { id, sequence, expiresAt };
}
