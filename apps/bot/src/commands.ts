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
  const now = deps.now();

  const existing = await deps.store.findLinkByDiscord(ctx.discordId);
  if (existing) {
    return ephemeral(
      `You are already linked to **${existing.gamertag}**. ` +
      "Run `/unlink` first if you need to bind a different character.",
    );
  }

  // ⚠️ Re-validating the autocomplete choice. Autocomplete is a suggestion,
  // not a constraint — Discord submits whatever the user typed — so both the
  // "unknown" and the "already taken" checks below have to exist server-side.
  // They are a friendlier refusal, not the enforcement. The real guarantees
  // behind a lost race are two database constraints:
  // `verification_challenges_open_target_uniq` (one open challenge per
  // character, whoever issued it) and `identity_links_dayz_uniq` (one link per
  // character). There is deliberately NO foreign key from
  // verification_challenges.target_dayz_id to players.dayz_id — the column is
  // bare `text NOT NULL` — so an unknown UID reaching the insert is refused by
  // nothing at all, and the lookup above is the only thing standing there.
  const target = await deps.store.playerByDayzId(ctx.targetDayzId);
  if (!target) {
    return ephemeral(
      "I have not seen that character on the server. Pick one from the list — " +
      "only characters the event log has seen can be linked.",
    );
  }
  const taken = await deps.store.findLinkByDayzId(target.dayzId);
  if (taken) {
    return ephemeral(
      `**${target.gamertag}** is already linked to another Discord account. ` +
      "If that character is yours, ask an admin.",
    );
  }

  // Re-show rather than re-issue: a player who lost the ephemeral reply should
  // not have their in-progress sequence invalidated, and must see the SAME
  // three emotes they already walked in game to perform.
  const live = await deps.store.findLiveChallenge(ctx.discordId, now);
  if (live && live.targetDayzId === target.dayzId) {
    return ephemeral(challengeMessage(live.sequence, live.expiresAt, target.gamertag));
  }

  // Naming a different character switches, it does not re-show. An account
  // gets one open challenge (uniqOpenPerAccount) and a challenge now lives for
  // 24 hours, so re-showing here would strand anyone who mis-picked out of the
  // autocomplete for a full day — and would strand the abandoned character
  // too, since its slot in verification_challenges_open_target_uniq stays
  // held. Replacing the challenge steals nothing, for exactly the reason the
  // TTL could be raised: a challenge names the one character that can satisfy
  // it.
  let switchedFrom: string | null = null;
  if (live) {
    // ⚠️ Ordering, not decoration: the cancel must run BEFORE the insert
    // below, or the new row collides with the row it replaces on
    // uniqOpenPerAccount (and on verification_challenges_open_target_uniq when
    // switching back to a character this account previously named). The
    // ordering is the whole requirement — an UPDATE that sets canceled_at
    // drops the row out of both partial indexes within its own transaction, so
    // these two statements are correct either autocommitted, as here, or
    // wrapped in one transaction. They are left autocommitted because the gap
    // is self-healing: a crash between them leaves the old challenge canceled
    // and both index slots free, so the next /link issues cleanly with neither
    // character locked out.
    //
    // cancelChallenge is the guarded cancel — it touches only a row that is
    // neither completed nor already canceled. False means the row closed under
    // us; the only way it closes as COMPLETE is the tick binding the old
    // target, so re-read the link before issuing anything.
    const canceled = await deps.store.cancelChallenge(live.id, now);
    if (!canceled) {
      const justLinked = await deps.store.findLinkByDiscord(ctx.discordId);
      if (justLinked) {
        return ephemeral(
          `You just finished linking to **${justLinked.gamertag}**. ` +
          "Run `/unlink` first if you need to bind a different character.",
        );
      }
    }
    switchedFrom = await nameOf(deps, live.targetDayzId);
  }

  // Close out challenges that expired without completing, before issuing a new
  // one: an expired row still occupies this account's one open-challenge slot
  // (uniqOpenPerAccount), so without this the insert below would be refused.
  await deps.store.cancelExpired(now);

  const expiresAt = new Date(now.getTime() + deps.challengeTtlMs);
  // One draw, no redraw loop. Sequences are no longer required to be unique
  // across live challenges — the open-sequence index was retired because three
  // emotes over the safe pool is only ~12k orderings, so live challenges would
  // collide routinely and reject legitimate /link calls. A collision is
  // harmless now that a challenge can only ever be satisfied by the character
  // it names.
  const sequence = generateSequence(deps.rng);
  const challenge = await deps.store.createChallenge({
    discordId: ctx.discordId, guildId: ctx.guildId, channelId: ctx.channelId,
    sequence, issuedAt: now, expiresAt, targetDayzId: target.dayzId,
  });
  if (challenge) {
    const body = challengeMessage(challenge.sequence, challenge.expiresAt, target.gamertag);
    // Say the old sequence is dead. A player who switched must not go on
    // performing emotes that can no longer bind anything.
    return ephemeral(switchedFrom === null
      ? body
      : `Canceled your challenge for **${switchedFrom}** — that sequence no longer works.\n\n${body}`);
  }

  // A null insert means the row lost to one of the two partial unique
  // indexes, and the two cases are told apart below because they mean
  // completely different things to the player.

  // uniqOpenPerAccount: a concurrent /link for this SAME account beat us to
  // the one open-challenge slot. Show theirs rather than erroring — it is the
  // same player, twice.
  const concurrent = await deps.store.findLiveChallenge(ctx.discordId, now);
  if (concurrent) {
    return ephemeral(challengeMessage(concurrent.sequence, concurrent.expiresAt, await nameOf(deps, concurrent.targetDayzId)));
  }

  // ⚠️ uniqOpenTarget: ANOTHER Discord account is already verifying this
  // character. This is not transient and must not be reported as one — that
  // index's predicate carries no expiry term, and cancelExpired above will
  // not touch the other account's unexpired row, so "try again in a moment"
  // would be a lie for up to the full 24h TTL while the player retried into
  // the same wall. Say what is true and when it ends.
  //
  // The other account's challenge is left strictly alone. Cancelling or
  // stealing it would hand anyone a way to knock a rival off the character
  // they are mid-way through verifying.
  const holder = await deps.store.findOpenChallengeByTarget(target.dayzId);
  if (holder && holder.discordId !== ctx.discordId) {
    return ephemeral(
      `Someone else is verifying **${target.gamertag}** right now, so I cannot issue a ` +
      `challenge for that character yet. Their attempt ends <t:${Math.floor(holder.expiresAt.getTime() / 1000)}:R> — ` +
      "run `/link` again after that. If that character is yours, ask an admin.",
    );
  }
  return ephemeral("Could not issue a challenge right now. Try again in a moment.");
}

/** Gamertag for a UID, falling back to the UID so a message is never blank. */
async function nameOf(deps: CommandDeps, dayzId: string): Promise<string> {
  return (await deps.store.playerByDayzId(dayzId))?.gamertag ?? dayzId;
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
