import type { Database } from "@factions/db";
import { readCursor, writeCursor, readEventBatch } from "@factions/event-log";
import { advance } from "@factions/verification";
import { safeVerificationEmotes } from "@factions/domain";
import type { VerificationStore } from "./store.js";

const SAFE_TOKENS = new Set(safeVerificationEmotes().map((e) => e.token));

/**
 * How many safe-pool emotes the challenge's TARGET may spend on one
 * challenge before it is canceled.
 *
 * ⚠️ Since the tick only ever advances a challenge for the UID it names (see
 * the comparison below), this is no longer defence-in-depth against a sweep
 * by some other attacker — no other UID's emotes reach this code at all. It
 * is the PRIMARY defence against the named target completing its own
 * sequence by accident over the life of the challenge: because matching holds
 * on a mismatch, a run of n distinct emotes completes any sequence that is an
 * ordered subsequence of it, so one run of n covers C(n, length) of the
 * sequence space just by chance.
 *
 * At a 24-token safe pool and length-3 sequences there are 24×23×22 = 12,144
 * ordered sequences. Eight emotes cover C(8,3) = 56 of them — about 0.46% —
 * so a target who fumbles for a full day still has under a 1-in-200 chance of
 * backing into their own sequence.
 *
 * A legitimate player needs three plus a few misfires. Raise it if players
 * report being locked out — but raise the sequence length with it, and do not
 * remove it.
 */
export const MAX_POOL_EMOTES_PER_ATTEMPT = 8;

/**
 * ⚠️ Distinct from the projector's "pole-projector". Two consumers sharing a
 * cursor name each skip the other's events, and the symptom is "verification
 * randomly doesn't work" rather than an error.
 */
export const CONSUMER = "identity-verifier";

export type TickOpts = { batchSize?: number; now?: Date };

export type TickResult = {
  /** emote.performed events examined. */
  scanned: number;
  /** attempts that moved forward. */
  advanced: number;
  /** challenges completed and bound. */
  verified: number;
  /**
   * Completions refused because the UID already belongs to another Discord
   * account. Counted rather than swallowed: a non-zero value here is either
   * someone re-linking without unlinking, or two people racing one UID.
   */
  alreadyLinked: number;
  /**
   * The challenge's named target exhausted its emote budget
   * (MAX_POOL_EMOTES_PER_ATTEMPT) without completing the sequence, and the
   * challenge was canceled as a result. Only the target's own emotes ever
   * reach this check, so a non-zero value means a fumbling player, not a
   * sweep attempt — no other UID's emotes get far enough to be counted.
   */
  lockedOut: number;
};

type EmotePayload = { dayzId: string; gamertag: string; emote: string };

function readEmotePayload(payload: unknown): EmotePayload | null {
  if (typeof payload !== "object" || payload === null) return null;
  const p = payload as Record<string, unknown>;
  if (typeof p.dayzId !== "string" || p.dayzId === "") return null;
  if (typeof p.emote !== "string" || p.emote === "") return null;
  // The ADM parser's identity regex captures at least one character, so an
  // empty gamertag means a malformed payload rather than a nameless player.
  // Rejecting it here keeps a blank display name out of identity_links.
  if (typeof p.gamertag !== "string" || p.gamertag === "") return null;
  return { dayzId: p.dayzId, gamertag: p.gamertag, emote: p.emote };
}

/** One pass: advance every live challenge against the unread emote events. */
export async function verificationTick(
  db: Database,
  store: VerificationStore,
  opts: TickOpts = {},
): Promise<TickResult> {
  const batchSize = opts.batchSize ?? 500;
  const now = opts.now ?? new Date();
  let cursor = await readCursor(db, CONSUMER);
  const out: TickResult = { scanned: 0, advanced: 0, verified: 0, alreadyLinked: 0, lockedOut: 0 };

  for (;;) {
    const batch = await readEventBatch(db, cursor, batchSize);
    if (batch.length === 0) break;

    for (const ev of batch) {
      cursor = ev.id;
      if (ev.type !== "emote.performed") continue;
      const payload = readEmotePayload(ev.payload);
      // A malformed payload is a parser bug, not a reason to stall the cursor.
      if (!payload) continue;
      out.scanned++;

      // Re-read live challenges per event: a completion inside this loop must
      // not leave a stale challenge in a cached list.
      for (const challenge of await store.liveChallenges(now)) {
        // ⚠️ A challenge may only be satisfied by emotes performed AFTER it was
        // issued. Without this, ingesting a historical log — or simply starting
        // with a cursor of 0 — replays weeks of past emotes at every live
        // challenge, and an unrelated player's history can complete it and bind
        // THEIR UID to this account. Event time, not row id: id order is
        // ingest order, which is not when the player acted.
        if (ev.occurredAt < challenge.issuedAt) continue;

        // ⚠️ THE security boundary. A challenge names the character it
        // verifies, so only that character's emotes may advance it. This one
        // comparison is why a three-emote sequence is sufficient and why the
        // open-sequence unique index could be retired. Removing it silently
        // restores the old lottery: any UID would win any live challenge.
        if (payload.dayzId !== challenge.targetDayzId) continue;

        const attempt = await store.getAttempt(challenge.id, payload.dayzId);
        const progressIndex = attempt?.progressIndex ?? 0;
        const lastMatchedEventId = attempt?.lastMatchedEventId ?? 0;
        // Replay guard: an event that already advanced this attempt must not
        // advance it again on a re-read.
        if (ev.id <= lastMatchedEventId) continue;

        // Tokens outside the safe pool can never appear in a sequence, so they
        // neither advance nor count against the budget. EmoteSitA alone is 77%
        // of all emote traffic in production; charging for it would exhaust a
        // legitimate player's budget by sitting down.
        if (!SAFE_TOKENS.has(payload.emote)) continue;

        const seenCount = attempt?.seenCount ?? 0;
        if (seenCount >= MAX_POOL_EMOTES_PER_ATTEMPT) {
          // Defensive only: the post-increment check below cancels the
          // challenge the moment the budget is actually spent, so a
          // still-live challenge should never be seen already at or past
          // budget. This stays as a backstop in case a canceled challenge
          // is somehow re-read as live within the same batch (e.g. a retry).
          out.lockedOut++;
          continue;
        }

        const { index, complete } = advance(challenge.sequence, progressIndex, payload.emote);

        if (complete) {
          // ⚠️ Completion is attempted BEFORE the attempt row is updated, and
          // the order is load-bearing. upsertAttempt writes lastMatchedEventId,
          // which the replay guard above uses to skip already-seen events. If
          // that marker were written first and completeChallenge then threw,
          // the batch would replay, the guard would skip this very event, and
          // the completion would never be retried — the player performs the
          // right sequence and can never be verified, silently. Writing the
          // marker only after the completion succeeds means a throw here
          // replays the event intact.
          const bound = await store.completeChallenge(challenge.id, challenge.targetDayzId, payload.gamertag, now);
          if (bound) out.verified++;
          else out.alreadyLinked++;
        }

        // Every safe-pool emote is recorded, whether or not it advanced —
        // otherwise the budget could never be spent and the sweep would work.
        await store.upsertAttempt(challenge.id, challenge.targetDayzId, index, ev.id, seenCount + 1);
        if (index !== progressIndex) out.advanced++;

        // ⚠️ Post-increment, not pre-increment: the budget is spent by THIS
        // write, so the cancel must fire on the event that reaches it, not
        // wait for a (possibly nonexistent) next one. A player who fumbles
        // exactly MAX_POOL_EMOTES_PER_ATTEMPT safe emotes and then logs off
        // must not hold their one open challenge slot for the full 24h TTL —
        // checking seenCount BEFORE the increment misses exactly that case,
        // since nothing ever revisits this challenge to notice.
        if (!complete && seenCount + 1 >= MAX_POOL_EMOTES_PER_ATTEMPT) {
          // Locked out per (challenge, UID), NOT per challenge: an attacker
          // burning their own budget must not deny the real player theirs.
          out.lockedOut++;
          // The named target has spent its whole budget without completing
          // the sequence. With a 24h TTL an inert, budget-exhausted challenge
          // would hold the player's one open slot for a day; cancel it now,
          // guarded so a concurrent completion or cancel is a no-op, so they
          // can run /link again immediately.
          await store.cancelChallenge(challenge.id, now);
        }
      }
    }
    await writeCursor(db, CONSUMER, cursor);
  }

  return out;
}
