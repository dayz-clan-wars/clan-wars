import type { Database } from "@factions/db";
import { readCursor, writeCursor, readEventBatch } from "@factions/event-log";
import { advance } from "@factions/verification";
import type { VerificationStore } from "./store.js";

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
};

type EmotePayload = { dayzId: string; gamertag: string; emote: string };

function readEmotePayload(payload: unknown): EmotePayload | null {
  if (typeof payload !== "object" || payload === null) return null;
  const p = payload as Record<string, unknown>;
  if (typeof p.dayzId !== "string" || typeof p.emote !== "string") return null;
  return {
    dayzId: p.dayzId,
    gamertag: typeof p.gamertag === "string" ? p.gamertag : "",
    emote: p.emote,
  };
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
  const out: TickResult = { scanned: 0, advanced: 0, verified: 0, alreadyLinked: 0 };

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
        const attempt = await store.getAttempt(challenge.id, payload.dayzId);
        const progressIndex = attempt?.progressIndex ?? 0;
        const lastMatchedEventId = attempt?.lastMatchedEventId ?? 0;
        // Replay guard: an event that already advanced this attempt must not
        // advance it again on a re-read.
        if (ev.id <= lastMatchedEventId) continue;

        const { index, complete } = advance(challenge.sequence, progressIndex, payload.emote);
        if (index === progressIndex) continue; // no forward progress

        await store.upsertAttempt(challenge.id, payload.dayzId, index, ev.id);
        out.advanced++;
        if (!complete) continue;

        const bound = await store.completeChallenge(challenge.id, payload.dayzId, payload.gamertag, now);
        if (bound) out.verified++;
        else out.alreadyLinked++;
      }
    }
    await writeCursor(db, CONSUMER, cursor);
  }

  return out;
}
