import { emoteLabel } from "@factions/domain";
import { issueChallenge } from "@factions/verification";
import type { VerificationStore } from "@factions/verification";

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
  /**
   * Best-effort, silent nickname clear for `/unlink`. Optional so tests that
   * don't care about Discord renames can omit it; when present it is never
   * allowed to make an otherwise-successful unlink report an error — the
   * unlink itself has already committed by the time this runs.
   */
  clearNickname?: (guildId: string, discordId: string) => Promise<void>;
};

/**
 * ⚠️ `targetDayzId` names the ONE character the challenge may be satisfied by.
 * Without it the sequence was a bearer token: any character performing the
 * emotes won the challenge, so a bystander who saw the reply could bind their
 * own UID to someone else's Discord account. The value comes from the
 * autocomplete choice, but a user can type anything into an autocomplete
 * field, so `handleLink` re-validates it.
 */
export type LinkContext = {
  discordId: string; guildId: string; channelId: string; targetDayzId: string;
  /**
   * Ask for a DIFFERENT sequence instead of being shown the live one again.
   *
   * The escape hatch for a player who cannot perform one of the three emotes:
   * without it, /link re-shows the same sequence and their only route out is
   * to spend the whole emote budget and wait to be locked out.
   */
  newSequence?: boolean;
};

const ephemeral = (content: string): Reply => ({ content, ephemeral: true });

/** Human labels, numbered. Players read an emote wheel, not a token list. */
export function formatSequence(sequence: string[]): string {
  return sequence.map((token, i) => `${i + 1}. **${emoteLabel(token) ?? token}**`).join("\n");
}

/** Spelled out for the player-facing text; the numeral is fine past a handful. */
const COUNT_WORDS = ["zero", "one", "two", "three", "four", "five", "six"];
const countWord = (n: number): string => COUNT_WORDS[n] ?? String(n);

function challengeMessage(sequence: string[], expiresAt: Date, gamertag: string): string {
  return [
    `**Link your account to ${gamertag}**`,
    "",
    // Naming the character is not decoration: the challenge can only be
    // satisfied by this one character, so a player who picked the wrong entry
    // must find that out here, not after walking in game to perform emotes.
    `In game, as **${gamertag}**, open the emote wheel and perform these, in this order:`,
    "",
    formatSequence(sequence),
    "",
    `Other emotes in between are fine — only the order of these ${countWord(sequence.length)} matters.`,
    `Expires <t:${Math.floor(expiresAt.getTime() / 1000)}:R>. Run ` + "`/link`" + ` again to see this message.`,
  ].join("\n");
}

export async function handleLink(deps: CommandDeps, ctx: LinkContext): Promise<Reply> {
  const out = await issueChallenge(deps.store, { rng: deps.rng, now: deps.now(), ttlMs: deps.challengeTtlMs }, {
    discordId: ctx.discordId, targetDayzId: ctx.targetDayzId, guildId: ctx.guildId, channelId: ctx.channelId,
    newSequence: ctx.newSequence,
  });
  // The strings below are the ones this command has always said; the
  // decisions behind them live in @factions/verification's issueChallenge,
  // which the site's /link shares.
  switch (out.kind) {
    case "already-linked":
    case "just-linked":
      return ephemeral(
        (out.kind === "just-linked" ? `You just finished linking to **${out.gamertag}**. ` : `You are already linked to **${out.gamertag}**. `) +
        "Run `/unlink` first if you need to bind a different character.",
      );
    case "unknown-character":
      return ephemeral(
        "I have not seen that character on the server. Pick one from the list — " +
        "only characters the event log has seen can be linked.",
      );
    case "taken":
      return ephemeral(
        `**${out.gamertag}** is already linked to another Discord account. ` +
        "If that character is yours, ask an admin.",
      );
    case "live":
      return ephemeral(challengeMessage(out.challenge.sequence, out.challenge.expiresAt, out.gamertag));
    case "too-many-draws":
      return ephemeral(
        `You have asked for too many sequences for **${out.gamertag}** today. ` +
        "Try again tomorrow — or, if there is an emote you cannot find on the wheel, " +
        "say so in the channel rather than working around it.",
      );
    case "issued": {
      const body = challengeMessage(out.challenge.sequence, out.challenge.expiresAt, out.gamertag);
      // Say the old sequence is dead. A player who switched must not go on
      // performing emotes that can no longer bind anything.
      return ephemeral(out.switchedFrom === null
        ? body
        : `Canceled your challenge for **${out.switchedFrom}** — that sequence no longer works.\n\n${body}`);
    }
    case "held-by-other":
      return ephemeral(
        `Someone else is verifying **${out.gamertag}** right now, so I cannot issue a ` +
        `challenge for that character yet. Their attempt ends <t:${Math.floor(out.expiresAt.getTime() / 1000)}:R> — ` +
        "run `/link` again after that. If that character is yours, ask an admin.",
      );
    case "unavailable":
      return ephemeral("Could not issue a challenge right now. Try again in a moment.");
  }
}

/**
 * ⚠️ Gated on roster membership. Unlinking is what binds a Discord account to
 * a UID, and a faction's leader is identified by their Discord id — so
 * unlinking a leader orphans the faction into exactly the frozen state §6's
 * succession mechanic exists to prevent, reachable in one command with no
 * confirmation.
 */
export async function handleUnlink(deps: CommandDeps, discordId: string, guildId: string): Promise<Reply> {
  const memberships = await deps.store.factionMembershipsFor(discordId);
  const leading = memberships.find((m) => m.role === "leader");
  if (leading) {
    return ephemeral(
      `You lead **${leading.factionName}** — transfer leadership or disband the faction before unlinking.`,
    );
  }
  if (memberships.length > 0) {
    return ephemeral(
      `You're a member of **${memberships[0]!.factionName}** — leave the faction before unlinking.`,
    );
  }

  const removed = await deps.store.deleteLinkByDiscord(discordId);
  if (removed && deps.clearNickname) {
    // Best-effort and silent: the unlink already committed, and a Discord
    // hiccup (or a permission the bot never had) must not turn a successful
    // unlink into a reported error.
    try {
      await deps.clearNickname(guildId, discordId);
    } catch (err) {
      console.warn(`nickname clear failed for ${discordId}`, err);
    }
  }
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
