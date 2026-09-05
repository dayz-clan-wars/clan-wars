import { generateSequence } from "./sequence";
import type { LiveChallenge, VerificationStore } from "./store";

/**
 * How many times one account may draw a sequence for one character inside
 * DRAW_WINDOW_MS. A security bound, not a courtesy limit: every draw carries
 * its own fresh emote budget (see the bot's MAX_POOL_EMOTES_PER_ATTEMPT), so
 * without this an unlimited succession of short-lived challenges would bound
 * nothing. Counts DRAWS, whatever their outcome — `countDrawsSince`.
 */
export const MAX_DRAWS_PER_TARGET = 3;
export const DRAW_WINDOW_MS = 86_400_000;

export const ISSUE_OUTCOME_KINDS = [
  "already-linked", "unknown-character", "taken", "live", "too-many-draws",
  "just-linked", "issued", "held-by-other", "unavailable",
] as const;
export type IssueOutcomeKind = (typeof ISSUE_OUTCOME_KINDS)[number];

export type IssueOutcome =
  | { kind: "already-linked"; gamertag: string }
  | { kind: "unknown-character" }
  | { kind: "taken"; gamertag: string }
  | { kind: "live"; challenge: LiveChallenge; gamertag: string }
  | { kind: "too-many-draws"; gamertag: string }
  | { kind: "just-linked"; gamertag: string }
  | { kind: "issued"; challenge: LiveChallenge; gamertag: string; switchedFrom: string | null }
  | { kind: "held-by-other"; gamertag: string; expiresAt: Date }
  | { kind: "unavailable" };

export type IssueDeps = { rng: () => number; now: Date; ttlMs: number };
export type IssueContext = {
  discordId: string;
  targetDayzId: string;
  /** Null when the site issues: there is no interaction to answer. */
  guildId: string | null;
  channelId: string | null;
  /** Ask for a different sequence for the SAME character instead of re-showing the live one. */
  newSequence?: boolean;
};

/**
 * Decide whether to issue a link challenge, and issue it. The one copy of
 * the rules the bot's `/link` and the site's `startLink` both apply (spec
 * §5.5); each caller only formats the outcome.
 *
 * ⚠️ Autocomplete is a suggestion, not a constraint — both callers submit
 * whatever the player typed — so "unknown" and "taken" are checked here,
 * server-side. They are the friendlier refusal, not the enforcement: the
 * guarantees behind a lost race are `verification_challenges_open_target_uniq`
 * (one open challenge per character) and `identity_links_dayz_uniq` (one link
 * per character). There is deliberately no foreign key from target_dayz_id to
 * players, so the `playerByDayzId` lookup is the only thing refusing an
 * unknown UID.
 */
export async function issueChallenge(store: VerificationStore, deps: IssueDeps, ctx: IssueContext): Promise<IssueOutcome> {
  const { now } = deps;

  const existing = await store.findLinkByDiscord(ctx.discordId);
  if (existing) return { kind: "already-linked", gamertag: existing.gamertag };

  const target = await store.playerByDayzId(ctx.targetDayzId);
  if (!target) return { kind: "unknown-character" };
  const taken = await store.findLinkByDayzId(target.dayzId);
  if (taken) return { kind: "taken", gamertag: target.gamertag };

  // Re-show rather than re-issue: a player who lost the page must see the SAME
  // three emotes they already walked in game to perform. `newSequence` is the
  // one way past this — a player who cannot perform one of the emotes is
  // asking for different ones, not for the same ones again.
  const live = await store.findLiveChallenge(ctx.discordId, now);
  if (live && live.targetDayzId === target.dayzId && ctx.newSequence !== true) {
    return { kind: "live", challenge: live, gamertag: target.gamertag };
  }

  // ⚠️ Checked on every path that goes on to ISSUE for this character — the
  // explicit re-roll, a first draw, and the switch-away-and-back below. A cap
  // that counted only explicit re-rolls would be bypassable with one extra
  // request.
  const drawn = await store.countDrawsSince(ctx.discordId, target.dayzId, new Date(now.getTime() - DRAW_WINDOW_MS));
  if (drawn >= MAX_DRAWS_PER_TARGET) return { kind: "too-many-draws", gamertag: target.gamertag };

  // Naming a different character switches, it does not re-show: an account
  // gets one open challenge (uniqOpenPerAccount), so re-showing would strand
  // anyone who mis-picked — and strand the abandoned character too, since its
  // slot in verification_challenges_open_target_uniq stays held. Replacing
  // steals nothing: a challenge names the one character that can satisfy it.
  let switchedFrom: string | null = null;
  if (live) {
    // ⚠️ Ordering, not decoration: the cancel must run BEFORE the insert
    // below, or the new row collides with the one it replaces on
    // uniqOpenPerAccount. Left autocommitted on purpose: a crash between the
    // two leaves the old challenge canceled and both index slots free.
    //
    // `cancelChallenge` is the guarded cancel — it touches only a row that is
    // neither completed nor already canceled. False means the row closed under
    // us; the only way it closes as COMPLETE is the tick binding the old
    // target, so re-read the link before issuing anything.
    const canceled = await store.cancelChallenge(live.id, now);
    if (!canceled) {
      const justLinked = await store.findLinkByDiscord(ctx.discordId);
      if (justLinked) return { kind: "just-linked", gamertag: justLinked.gamertag };
    }
    // Only a genuine switch to a DIFFERENT character is reported as one — a
    // `newSequence` re-roll of the SAME character cancels and replaces the
    // row too (uniqOpenPerAccount), but it is not a switch, so it must not
    // self-announce "Canceled your challenge for **Ronald**" while issuing a
    // fresh one for Ronald in the same breath.
    if (live.targetDayzId !== target.dayzId) {
      switchedFrom = (await store.playerByDayzId(live.targetDayzId))?.gamertag ?? live.targetDayzId;
    }
  }

  // An expired row still occupies this account's one open-challenge slot
  // (uniqOpenPerAccount), so close those out before the insert below.
  await store.cancelExpired(now);

  const expiresAt = new Date(now.getTime() + deps.ttlMs);
  // One draw, no redraw loop: sequences need not be unique across live
  // challenges, because a challenge can only be satisfied by the character it
  // names (the open-sequence index was retired for that reason).
  const sequence = generateSequence(deps.rng);
  const challenge = await store.createChallenge({
    discordId: ctx.discordId, guildId: ctx.guildId, channelId: ctx.channelId,
    sequence, issuedAt: now, expiresAt, targetDayzId: target.dayzId,
  });
  if (challenge) return { kind: "issued", challenge, gamertag: target.gamertag, switchedFrom };

  // A null insert lost to one of two partial unique indexes, and they mean
  // different things to the player.

  // uniqOpenPerAccount: a concurrent request for this SAME account beat us to
  // the slot. Show theirs — it is the same player, twice.
  const concurrent = await store.findLiveChallenge(ctx.discordId, now);
  if (concurrent) {
    const name = (await store.playerByDayzId(concurrent.targetDayzId))?.gamertag ?? concurrent.targetDayzId;
    return { kind: "live", challenge: concurrent, gamertag: name };
  }

  // ⚠️ uniqOpenTarget: ANOTHER account is verifying this character. Not
  // transient — that index's predicate carries no expiry term, and
  // cancelExpired above does not touch another account's unexpired row — so
  // "try again in a moment" would be a lie for the whole TTL. Say when it
  // ends. The other account's challenge is left strictly alone: cancelling it
  // would hand anyone a way to knock a rival off a character mid-verification.
  const holder = await store.findOpenChallengeByTarget(target.dayzId);
  if (holder && holder.discordId !== ctx.discordId) {
    return { kind: "held-by-other", gamertag: target.gamertag, expiresAt: holder.expiresAt };
  }
  return { kind: "unavailable" };
}
