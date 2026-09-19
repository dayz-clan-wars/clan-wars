import type { Database } from "@factions/db";
import { boosterKits, boosterKitChallenges } from "@factions/db";
import { readCursor, writeCursor, readEventBatch } from "@factions/event-log";
import { advance, isExpired } from "@factions/verification";
import { safeVerificationEmotes, type Vec3 } from "@factions/domain";
import { and, eq, isNull } from "drizzle-orm";

const SAFE_TOKENS = new Set(safeVerificationEmotes().map((e) => e.token));

/**
 * ⚠️ Its OWN cursor name, distinct from tick.ts's "identity-verifier" and the
 * projector's "pole-projector". A consumer cursor is a single watermark per
 * name: two consumers sharing one each advance it past the other's unread
 * events, so each silently skips roughly half the log. The symptom is
 * "placement randomly does not work", not an error.
 */
export const KIT_PLACEMENT_CONSUMER = "kit-placement";

/**
 * How many safe-pool emotes the challenge's named character may spend before
 * the challenge is closed.
 *
 * Same budget and the same reasoning as tick.ts's constant of the same name:
 * because `advance` HOLDS on a mismatch, a run of n distinct safe emotes
 * completes any sequence that is an ordered subsequence of it, so the budget
 * is what stops the named character backing into their own sequence by
 * accident over the life of the challenge. Eight emotes cover C(8,3) = 56 of
 * the 24x23x22 = 12,144 ordered sequences — about 0.46%.
 *
 * What it costs here is milder than in tick.ts: an accidental completion moves
 * a booster's own kit to wherever they were standing, rather than binding an
 * identity. It stays anyway, because an unnoticed kit in the wrong place is
 * exactly as confusing as no kit, and the player has no way to tell which
 * happened.
 */
export const MAX_POOL_EMOTES_PER_ATTEMPT = 8;

export type KitPlacementOpts = { batchSize?: number; now?: Date };

export type KitPlacementResult = {
  /** emote.performed events examined. */
  scanned: number;
  /** challenges that moved forward. */
  advanced: number;
  /** challenges completed, with a position written to the kit. */
  placed: number;
  /**
   * The challenge's named character spent its whole emote budget without
   * completing, and the challenge was closed as a result. Only that
   * character's emotes ever reach the counter, so a non-zero value means a
   * fumbling booster, not a sweep.
   */
  lockedOut: number;
  /** Challenges found past their expiry and closed. The spot is never touched. */
  expired: number;
};

type EmotePayload = { dayzId: string; emote: string; pos: Vec3 | null };

/**
 * ⚠️ `pos` is a Vec3 — an OBJECT, with `y` ALWAYS altitude. `parsePlayerPos`
 * already normalised the ADM line's `pos=<x, z, altitude>` into that shape, so
 * there is no ordering left to undo here. Destructuring it as a tuple, or
 * swapping y and z on the way to the columns, would put every kit underground
 * or off the map, silently — the write succeeds and nothing downstream
 * complains.
 */
function readEmotePayload(payload: unknown): EmotePayload | null {
  if (typeof payload !== "object" || payload === null) return null;
  const p = payload as Record<string, unknown>;
  if (typeof p.dayzId !== "string" || p.dayzId === "") return null;
  if (typeof p.emote !== "string" || p.emote === "") return null;
  // Unlike tick.ts, the gamertag is NOT required: this tick binds a location
  // to an account that is already linked, so it never writes a display name
  // and a missing one costs nothing.
  return { dayzId: p.dayzId, emote: p.emote, pos: readPos(p.pos) };
}

function readPos(pos: unknown): Vec3 | null {
  if (typeof pos !== "object" || pos === null) return null;
  const p = pos as Record<string, unknown>;
  if (typeof p.x !== "number" || typeof p.y !== "number" || typeof p.z !== "number") return null;
  if (!Number.isFinite(p.x) || !Number.isFinite(p.y) || !Number.isFinite(p.z)) return null;
  return { x: p.x, y: p.y, z: p.z };
}

type OpenChallenge = typeof boosterKitChallenges.$inferSelect;

function openChallenges(db: Database): Promise<OpenChallenge[]> {
  return db.select().from(boosterKitChallenges).where(isNull(boosterKitChallenges.closedAt));
}

/** One pass: advance every open placement challenge against the unread emote events. */
export async function kitPlacementTick(
  db: Database,
  opts: KitPlacementOpts = {},
): Promise<KitPlacementResult> {
  const batchSize = opts.batchSize ?? 500;
  const now = opts.now ?? new Date();
  let cursor = await readCursor(db, KIT_PLACEMENT_CONSUMER);
  const out: KitPlacementResult = { scanned: 0, advanced: 0, placed: 0, lockedOut: 0, expired: 0 };

  for (;;) {
    const batch = await readEventBatch(db, cursor, batchSize);
    if (batch.length === 0) break;

    // Open challenges, read once per batch rather than once per event — the
    // same cost argument as tick.ts, where the per-event read cost 2,093
    // queries on the historical backfill.
    //
    // ⚠️ Every write below drops the cache. This is a STRICTER rule than
    // tick.ts's, and deliberately so: tick.ts keeps per-attempt progress in a
    // separate table it re-reads per (event x challenge), so only a
    // completion or cancellation could stale its cached list. Here progress
    // lives on the challenge row itself, so a progress-only write stales it
    // too — a cached row would hand the next event a progressIndex and a
    // lastMatchedEventId from before the write, and the replay guard would
    // stop guarding.
    let live: OpenChallenge[] | null = null;
    const liveNow = async () => (live ??= await openChallenges(db));
    const invalidate = () => { live = null; };

    for (const ev of batch) {
      cursor = ev.id;
      if (ev.type !== "emote.performed") continue;
      const payload = readEmotePayload(ev.payload);
      // A malformed payload is a parser bug, not a reason to stall the cursor.
      if (!payload) continue;
      out.scanned++;

      for (const challenge of await liveNow()) {
        // ⚠️ A challenge may only be satisfied by emotes performed AFTER it
        // was issued. Without this, a cursor that starts at 0 — or an ingested
        // historical log — replays weeks of past emotes at every open
        // challenge, and the kit lands wherever the player happened to be
        // standing days ago. Event time, not row id: id order is ingest order,
        // which is not when the player acted.
        if (ev.occurredAt < challenge.issuedAt) continue;

        // ⚠️ THE security boundary. The challenge names the character that may
        // mark the spot; without this comparison ANY player's emotes could
        // move someone else's kit, and the victim would have no way to see
        // who did it or why their crate moved.
        if (payload.dayzId !== challenge.targetDayzId) continue;

        // Checked here rather than in the `openChallenges` query so an expired
        // challenge is actively CLOSED the first time its character emotes
        // again, instead of sitting open forever holding the account's one
        // open-challenge slot. Before the safe-token filter on purpose: any
        // emote at all is enough evidence that the row is stale.
        //
        // ⚠️ Closing is all that happens. The kit's existing spot is left
        // exactly as it was — moving a kit is never destructive until the new
        // spot is actually witnessed, and an expired attempt witnessed
        // nothing.
        if (isExpired(challenge, now)) {
          await closeChallenge(db, challenge.id, now);
          invalidate();
          out.expired++;
          continue;
        }

        // Replay guard: an event that already advanced this challenge must
        // not advance it again on a re-read.
        if (ev.id <= challenge.lastMatchedEventId) continue;

        // Tokens outside the safe pool can never appear in a sequence, so they
        // neither advance nor spend budget. EmoteSitA alone is 77% of all
        // emote traffic in production; charging for it would exhaust a
        // legitimate player's budget by sitting down.
        if (!SAFE_TOKENS.has(payload.emote)) continue;

        if (challenge.seenCount >= MAX_POOL_EMOTES_PER_ATTEMPT) {
          // Defensive only: the post-increment check below closes the
          // challenge the moment the budget is actually spent, so an open
          // challenge should never be seen already at budget.
          out.lockedOut++;
          continue;
        }

        const { index, complete } = advance(challenge.sequence, challenge.progressIndex, payload.emote);

        if (complete && payload.pos === null) {
          // ⚠️ Nothing is written — not the position, not the progress, not
          // the seen count, not the replay marker. The sequence is right but
          // the log line carried no position block, and a completion with
          // nowhere to put the kit is not a completion. Leaving every counter
          // untouched means the player simply performs the last emote again
          // where they are standing and it works, rather than being told the
          // sequence is spent for a reason they cannot see.
          continue;
        }

        if (complete) {
          const pos = payload.pos!;
          // ⚠️ ONE transaction for the position and the close. A crash
          // between them would leave an open challenge that has ALREADY moved
          // the kit, and the player's next safe emote would move it again —
          // to wherever they walked in the meantime.
          await db.transaction(async (tx) => {
            await tx.update(boosterKits).set({
              // ⚠️ Straight across. `pos` is a Vec3 whose `y` is altitude, and
              // pos_y is the altitude column, exactly as `declarations.y` is.
              // There is no ADM-order conversion anywhere in this path; adding
              // one would bury every kit or throw it off the map.
              posX: pos.x.toFixed(2), posY: pos.y.toFixed(2), posZ: pos.z.toFixed(2),
              placedAt: now, updatedAt: now,
            }).where(eq(boosterKits.discordId, challenge.discordId));
            await tx.update(boosterKitChallenges).set({
              progressIndex: index,
              seenCount: challenge.seenCount + 1,
              lastMatchedEventId: ev.id,
              closedAt: now,
            }).where(and(
              eq(boosterKitChallenges.id, challenge.id),
              // Guarded so a challenge re-issued or closed concurrently — the
              // site can re-open the page at any moment — is a no-op here
              // rather than a second placement.
              isNull(boosterKitChallenges.closedAt),
            ));
          });
          invalidate();
          out.placed++;
          out.advanced++;
          continue;
        }

        // Every safe-pool emote is recorded whether or not it advanced —
        // otherwise the budget could never be spent.
        await db.update(boosterKitChallenges).set({
          progressIndex: index,
          seenCount: challenge.seenCount + 1,
          lastMatchedEventId: ev.id,
        }).where(eq(boosterKitChallenges.id, challenge.id));
        invalidate();
        if (index !== challenge.progressIndex) out.advanced++;

        // ⚠️ Post-increment, not pre-increment: the budget is spent by THIS
        // write, so the close must fire on the event that reaches it rather
        // than wait for a next one that may never come. A booster who fumbles
        // exactly MAX_POOL_EMOTES_PER_ATTEMPT emotes and then logs off must
        // not hold their one open-challenge slot until the TTL runs out —
        // checking before the increment misses exactly that case, since
        // nothing revisits the challenge to notice.
        if (challenge.seenCount + 1 >= MAX_POOL_EMOTES_PER_ATTEMPT) {
          out.lockedOut++;
          await closeChallenge(db, challenge.id, now);
          invalidate();
        }
      }
    }
    await writeCursor(db, KIT_PLACEMENT_CONSUMER, cursor);
  }

  return out;
}

function closeChallenge(db: Database, id: number, now: Date): Promise<unknown> {
  return db.update(boosterKitChallenges).set({ closedAt: now })
    .where(and(eq(boosterKitChallenges.id, id), isNull(boosterKitChallenges.closedAt)));
}
