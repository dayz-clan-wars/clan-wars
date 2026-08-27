import { emoteLabel } from "@factions/domain";
import { generateSequence } from "@factions/verification";
import type { VerificationStore } from "./store.js";

/**
 * ⚠️ Every reply is ephemeral. A challenge sequence posted publicly is a
 * challenge anyone reading the channel can perform, which would let a bystander
 * bind their own UID to someone else's Discord account.
 */
export type Reply = { content: string; ephemeral: true };

export type CommandDeps = {
  store: VerificationStore;
  rng: () => number;
  now: () => Date;
  challengeTtlMs: number;
};

export type LinkContext = { discordId: string; guildId: string; channelId: string };

const ephemeral = (content: string): Reply => ({ content, ephemeral: true });

/** Human labels, numbered. Players read an emote wheel, not a token list. */
export function formatSequence(sequence: string[]): string {
  return sequence.map((token, i) => `${i + 1}. **${emoteLabel(token) ?? token}**`).join("\n");
}

function challengeMessage(sequence: string[], expiresAt: Date): string {
  return [
    "**Link your account**",
    "",
    "In game, open the emote wheel and perform these, in this order:",
    "",
    formatSequence(sequence),
    "",
    "Other emotes in between are fine — only the order of these three matters.",
    `Expires <t:${Math.floor(expiresAt.getTime() / 1000)}:R>. Run ` + "`/link`" + ` again to see this message.`,
  ].join("\n");
}

export async function handleLink(deps: CommandDeps, ctx: LinkContext): Promise<Reply> {
  const now = deps.now();

  const existing = await deps.store.findLinkByDiscord(ctx.discordId);
  if (existing) {
    return ephemeral(
      `You are already linked to **${existing.gamertag}**. ` +
      "Run `/unlink` first if you need to bind a different character.",
    );
  }

  // Re-show rather than re-issue: a player who lost the ephemeral reply should
  // not have their in-progress sequence invalidated.
  const live = await deps.store.findLiveChallenge(ctx.discordId, now);
  if (live) return ephemeral(challengeMessage(live.sequence, live.expiresAt));

  // Release sequences held by challenges that expired without completing,
  // before drawing. Cheap, and it keeps the open-sequence pool from silting up.
  await deps.store.cancelExpired(now);

  const expiresAt = new Date(now.getTime() + deps.challengeTtlMs);
  // ⚠️ The insert is the uniqueness check. A read-then-check would let two
  // concurrent /link calls be issued the same sequence, and two live
  // challenges sharing a sequence bind the wrong account (see the index
  // comment in schema.ts). The first draw uses deps.rng so tests can pin it;
  // redraws use Math.random, because a deterministic rng that collided once
  // would collide forever.
  for (let attempt = 0; attempt < 20; attempt++) {
    const sequence = generateSequence(attempt === 0 ? deps.rng : Math.random);
    const challenge = await deps.store.createChallenge({
      discordId: ctx.discordId, guildId: ctx.guildId, channelId: ctx.channelId,
      sequence, issuedAt: now, expiresAt,
    });
    if (challenge) return ephemeral(challengeMessage(challenge.sequence, challenge.expiresAt));

    // Null insert may mean the sequence collided (redraw and retry) OR that a
    // concurrent /link for this same account beat us to it (the new
    // uniqOpenPerAccount index) — a reason the redraw loop cannot fix. Check
    // for a now-live challenge on this account and show that instead.
    const concurrent = await deps.store.findLiveChallenge(ctx.discordId, now);
    if (concurrent) return ephemeral(challengeMessage(concurrent.sequence, concurrent.expiresAt));
  }
  return ephemeral("Could not issue a unique sequence right now. Try again in a moment.");
}

export async function handleUnlink(deps: CommandDeps, discordId: string): Promise<Reply> {
  const removed = await deps.store.deleteLinkByDiscord(discordId);
  return ephemeral(
    removed
      ? "Unlinked. Run `/link` to bind a character again."
      : "You are not linked to a character.",
  );
}

export async function handleWhoami(deps: CommandDeps, discordId: string): Promise<Reply> {
  const link = await deps.store.findLinkByDiscord(discordId);
  if (!link) return ephemeral("You are not linked to a character. Run `/link` to start.");
  return ephemeral(
    `Linked to **${link.gamertag}** ` +
    `(verified <t:${Math.floor(link.verifiedAt.getTime() / 1000)}:D>).`,
  );
}
