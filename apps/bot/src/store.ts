import type { Database } from "@factions/db";
import { identityLinks, verificationChallenges, challengeAttempts, factions, factionMembers, players } from "@factions/db";
import { and, count, desc, eq, gte, inArray, isNull, isNotNull, lt, or } from "drizzle-orm";
import { HOLDING_STATUSES } from "@factions/domain";
import type { Role } from "./roster-store.js";

/** Statuses under which a faction still holds its flag and roster. */
// Widened to a mutable array: HOLDING_STATUSES is `as const` (a readonly
// tuple) so every faction/domain consumer gets full literal-type checking,
// but drizzle's inArray() requires a plain mutable array.
const HOLDING: string[] = [...HOLDING_STATUSES];

export type LiveChallenge = {
  id: number; discordId: string; guildId: string; channelId: string;
  sequence: string[]; issuedAt: Date; expiresAt: Date; targetDayzId: string;
};
export type Attempt = { id: number; progressIndex: number; lastMatchedEventId: number; seenCount: number };

/**
 * Why a challenge was canceled, when the player has to be told about it.
 *
 * ⚠️ A reason is what makes a cancellation notifiable — see
 * `pendingNotifications`. Cancels the player already knows about (the
 * switch-cancel in `/link`, which says so in its own reply) and cancels
 * nobody is waiting on (`cancelExpired`) deliberately pass none.
 */
export type CancelReason = "budget-exhausted";

/**
 * A challenge whose outcome the player has not been told about yet.
 *
 * `boundDayzId` is non-null exactly when `outcome` is "completed" — the
 * schema forbids a bound row that is not complete.
 */
export type PendingNotification = LiveChallenge & (
  | { outcome: "completed"; boundDayzId: string }
  /**
   * `progressIndex` is how far into the sequence the target actually got —
   * the same value `challenge_attempts` holds, or 0 when no attempt row
   * exists because they performed no safe-pool emote at all.
   *
   * Carried so the lockout message can name the emote that blocked them
   * rather than only apologising. A player stuck at 0 could not perform the
   * FIRST emote, which is a different problem from fumbling the order, and
   * is how an unperformable token in the safe pool becomes visible.
   */
  | { outcome: CancelReason; boundDayzId: null; progressIndex: number }
);

export interface VerificationStore {
  findLinkByDiscord(discordId: string): Promise<{ dayzId: string; gamertag: string; verifiedAt: Date } | null>;
  findLinkByDayzId(dayzId: string): Promise<{ discordId: string } | null>;
  deleteLinkByDiscord(discordId: string): Promise<boolean>;
  /**
   * ⚠️ Gated on roster membership. Unlinking is what binds a Discord account to
   * a UID, and a faction's leader is identified by their Discord id — so
   * unlinking a leader orphans the faction into exactly the frozen state §6's
   * succession mechanic exists to prevent, reachable in one command.
   */
  factionMembershipsFor(discordId: string): Promise<{ factionName: string; role: Role }[]>;
  findLiveChallenge(discordId: string, now: Date): Promise<LiveChallenge | null>;
  /**
   * The open challenge holding this character's slot, whoever owns it.
   *
   * ⚠️ Deliberately NOT time-bounded, unlike `findLiveChallenge`. This
   * answers "what is blocking an insert on
   * verification_challenges_open_target_uniq", and that index's predicate is
   * `completed_at IS NULL AND canceled_at IS NULL` with no expiry term — an
   * expired-but-uncancelled row blocks just as hard as a live one. Narrowing
   * this to live rows would report "nothing is holding it" about a row that
   * demonstrably is.
   */
  findOpenChallengeByTarget(targetDayzId: string): Promise<{ discordId: string; expiresAt: Date } | null>;
  /**
   * How many challenges this account has drawn for this character since
   * `since`, whatever their outcome.
   *
   * ⚠️ Counts DRAWS, not live challenges — a canceled or completed one still
   * counts. Each draw carries its own fresh emote budget, so counting only
   * live rows would bound nothing: the caller's cap exists precisely to stop
   * an unlimited succession of short-lived challenges.
   */
  countDrawsSince(discordId: string, targetDayzId: string, since: Date): Promise<number>;
  liveChallenges(now: Date): Promise<LiveChallenge[]>;
  createChallenge(input: { discordId: string; guildId: string; channelId: string; sequence: string[]; issuedAt: Date; expiresAt: Date; targetDayzId: string }): Promise<LiveChallenge | null>;
  getAttempt(challengeId: number, dayzId: string): Promise<Attempt | null>;
  upsertAttempt(challengeId: number, dayzId: string, progressIndex: number, lastMatchedEventId: number, seenCount: number): Promise<void>;
  completeChallenge(challengeId: number, dayzId: string, gamertag: string, at: Date): Promise<boolean>;
  pendingNotifications(): Promise<PendingNotification[]>;
  markNotified(challengeId: number, at: Date): Promise<void>;
  cancelExpired(now: Date): Promise<number>;
  /**
   * Cancel one still-open challenge, guarded the same way `cancelExpired` is:
   * only a row that is neither completed nor already canceled is touched, so
   * a race with `completeChallenge` or a concurrent cancel is a no-op rather
   * than an error.
   *
   * Passing a `reason` also makes the cancellation notifiable — the player
   * gets a DM saying what happened. Omit it when the player has already been
   * told (the `/link` switch-cancel says so in its own reply).
   */
  cancelChallenge(challengeId: number, at: Date, reason?: CancelReason): Promise<boolean>;
  /** The `limit` most recently seen players with no identity link, newest first. */
  recentUnlinkedPlayers(limit: number): Promise<{ dayzId: string; gamertag: string }[]>;
  /** One player by UID, or null if the event log has never seen them. */
  playerByDayzId(dayzId: string): Promise<{ dayzId: string; gamertag: string } | null>;
}

/** A challenge is live when it is neither completed nor canceled and has not expired. */
const liveWhere = (now: Date) => and(
  isNull(verificationChallenges.completedAt),
  isNull(verificationChallenges.canceledAt),
  gte(verificationChallenges.expiresAt, now),
);

export class PgVerificationStore implements VerificationStore {
  constructor(private readonly db: Database) {}

  async findLinkByDiscord(discordId: string) {
    const [row] = await this.db.select().from(identityLinks).where(eq(identityLinks.discordId, discordId));
    return row ? { dayzId: row.dayzId, gamertag: row.gamertag, verifiedAt: row.verifiedAt } : null;
  }

  async findLinkByDayzId(dayzId: string) {
    const [row] = await this.db.select().from(identityLinks).where(eq(identityLinks.dayzId, dayzId));
    return row ? { discordId: row.discordId } : null;
  }

  async deleteLinkByDiscord(discordId: string): Promise<boolean> {
    const rows = await this.db.delete(identityLinks).where(eq(identityLinks.discordId, discordId)).returning();
    return rows.length > 0;
  }

  async factionMembershipsFor(discordId: string): Promise<{ factionName: string; role: Role }[]> {
    const rows = await this.db.select({
      factionName: factions.name,
      role: factionMembers.role,
    }).from(factionMembers)
      .innerJoin(factions, eq(factionMembers.factionId, factions.id))
      .where(and(eq(factionMembers.discordId, discordId), inArray(factions.status, HOLDING)));
    return rows.map((r) => ({ ...r, role: r.role as Role }));
  }

  async findLiveChallenge(discordId: string, now: Date): Promise<LiveChallenge | null> {
    const [row] = await this.db.select().from(verificationChallenges)
      .where(and(eq(verificationChallenges.discordId, discordId), liveWhere(now)));
    return row ? toLive(row) : null;
  }

  async countDrawsSince(discordId: string, targetDayzId: string, since: Date): Promise<number> {
    const [row] = await this.db.select({ n: count() }).from(verificationChallenges).where(and(
      eq(verificationChallenges.discordId, discordId),
      eq(verificationChallenges.targetDayzId, targetDayzId),
      gte(verificationChallenges.issuedAt, since),
    ));
    return row?.n ?? 0;
  }

  async findOpenChallengeByTarget(targetDayzId: string): Promise<{ discordId: string; expiresAt: Date } | null> {
    const [row] = await this.db.select().from(verificationChallenges).where(and(
      eq(verificationChallenges.targetDayzId, targetDayzId),
      isNull(verificationChallenges.completedAt),
      isNull(verificationChallenges.canceledAt),
    ));
    return row ? { discordId: row.discordId, expiresAt: row.expiresAt } : null;
  }

  async liveChallenges(now: Date): Promise<LiveChallenge[]> {
    const rows = await this.db.select().from(verificationChallenges).where(liveWhere(now));
    return rows.map(toLive);
  }

  /**
   * Insert a challenge, or return null when this account already has an open
   * one (`uniqOpenPerAccount`). Null is an expected outcome, not an error —
   * the caller shows the challenge that won instead. Sequences are NOT unique
   * across live challenges any more: a challenge names the one character that
   * may satisfy it, so a shared sequence binds nobody's account by accident.
   */
  async createChallenge(input: {
    discordId: string; guildId: string; channelId: string;
    sequence: string[]; issuedAt: Date; expiresAt: Date; targetDayzId: string;
  }): Promise<LiveChallenge | null> {
    const [row] = await this.db.insert(verificationChallenges).values(input)
      .onConflictDoNothing()
      .returning();
    return row ? toLive(row) : null;
  }

  async getAttempt(challengeId: number, dayzId: string): Promise<Attempt | null> {
    const [row] = await this.db.select().from(challengeAttempts)
      .where(and(eq(challengeAttempts.challengeId, challengeId), eq(challengeAttempts.dayzId, dayzId)));
    return row ? { id: row.id, progressIndex: row.progressIndex, lastMatchedEventId: row.lastMatchedEventId, seenCount: row.seenCount } : null;
  }

  async upsertAttempt(challengeId: number, dayzId: string, progressIndex: number, lastMatchedEventId: number, seenCount: number): Promise<void> {
    await this.db.insert(challengeAttempts)
      .values({ challengeId, dayzId, progressIndex, lastMatchedEventId, seenCount })
      .onConflictDoUpdate({
        target: [challengeAttempts.challengeId, challengeAttempts.dayzId],
        set: { progressIndex, lastMatchedEventId, seenCount },
      });
  }

  /**
   * Bind the UID and close the challenge, atomically.
   *
   * Returns false when the UID is already linked to a different Discord
   * account — the losing side of a race, not an error. The challenge is
   * canceled in that case so the player is not left waiting on a sequence
   * that can never bind.
   *
   * Also returns false, changing nothing at all, when `dayzId` is not the
   * challenge's `targetDayzId`. A challenge binds only the character it
   * names; see the guard inside.
   */
  async completeChallenge(challengeId: number, dayzId: string, gamertag: string, at: Date): Promise<boolean> {
    return this.db.transaction(async (tx) => {
      // ⚠️ FOR UPDATE, and the open-ness check below, are both load-bearing.
      // A plain read lets a concurrent cancelExpired (every /link fires one)
      // close this row while we go on to insert the identity link — binding a
      // UID on the strength of a challenge that no longer exists. Taking the
      // row lock here makes that cancel wait; when it resumes, its own
      // `completed_at IS NULL` predicate is re-evaluated against our committed
      // row and correctly skips it.
      const [challenge] = await tx.select().from(verificationChallenges)
        .where(eq(verificationChallenges.id, challengeId))
        .for("update");
      if (!challenge) return false;
      // Lost the race before we got the lock: not an error, just not ours.
      if (challenge.completedAt !== null || challenge.canceledAt !== null) return false;

      // ⚠️ THE security property, enforced by the store itself. A challenge
      // may only ever bind the ONE character it names. The tick has its own
      // UID-equality guard, but this must not depend on it: without the check
      // here, a caller passing the wrong UID still reaches the identity_links
      // INSERT below and binds this Discord account to a UID its challenge
      // never named — only the challenge UPDATE is refused (its predicate
      // includes target_dayz_id), so the caller is told `false` while the
      // wrong link sits committed and the challenge is left open, holding
      // both its account slot and its target slot for the full TTL with the
      // player unable to see or cancel it.
      //
      // Not a pre-read-then-write: this runs inside the FOR UPDATE
      // transaction that already holds the row, so the value cannot change
      // under us before the writes below.
      if (challenge.targetDayzId !== dayzId) return false;

      // ⚠️ Both outcomes are guarded on the challenge still being open, and the
      // guard is part of the same statement as the write — the SELECT above is
      // a plain read, so a concurrent cancelExpired (any /link fires one) can
      // close this row between that read and here. Writing unconditionally then
      // violates verification_challenges_single_outcome, and the throw escapes
      // verificationTick: the batch cursor is never written and the whole
      // batch is redone, forever. Zero affected rows means we lost the race,
      // which is a false return, not an error.
      // ⚠️ targetDayzId is repeated here as genuine defence in depth. The
      // guarantee that this store never binds a UID a challenge does not name
      // is provided by the equality check above, under the row lock — this
      // copy is a second, statement-level backstop so neither write can touch
      // a row whose target changed, or be reached by some future path that
      // skips the check above.
      const stillOpen = and(
        eq(verificationChallenges.id, challengeId),
        eq(verificationChallenges.targetDayzId, dayzId),
        isNull(verificationChallenges.completedAt),
        isNull(verificationChallenges.canceledAt),
      );

      const cancel = async () => {
        await tx.update(verificationChallenges)
          .set({ canceledAt: at })
          .where(stillOpen);
        return false;
      };

      const complete = async () => {
        // completed_at and bound_dayz_id are set in ONE statement: the schema
        // forbids a bound row that is not complete.
        const done = await tx.update(verificationChallenges)
          .set({ completedAt: at, boundDayzId: dayzId })
          .where(stillOpen)
          .returning({ id: verificationChallenges.id });
        return done.length > 0;
      };

      const [taken] = await tx.select().from(identityLinks)
        .where(eq(identityLinks.dayzId, dayzId));
      if (taken) {
        // Already bound to THIS account: the player re-ran a challenge they had
        // already satisfied. Idempotent success, no insert needed.
        if (taken.discordId === challenge.discordId) return complete();
        return cancel();
      }

      // ⚠️ .returning() is load-bearing. Between the read above and this insert,
      // a concurrent transaction may have claimed either this UID or this
      // Discord account; ON CONFLICT DO NOTHING then affects zero rows and
      // raises nothing. Reporting completion on the strength of the earlier
      // read would mark the challenge bound with no link row behind it — the
      // player is told they are verified and they are not. The insert's own
      // outcome is the only thing that may decide this.
      const inserted = await tx.insert(identityLinks)
        .values({ discordId: challenge.discordId, dayzId, gamertag, verifiedAt: at })
        .onConflictDoNothing()
        .returning();

      if (inserted.length === 0) return cancel();
      return complete();
    });
  }

  /**
   * Outcomes the player still has to hear about: completions, and the
   * cancellations that carry a reason.
   *
   * ⚠️ The cancellation half keys on `cancel_reason`, NOT on `canceled_at`.
   * Every expiry and every `/link` switch-cancel also sets `canceled_at`, and
   * none of those should be DMed — least of all the pile of them already in
   * the table, which a `canceled_at IS NOT NULL` predicate would make pending
   * all at once on the first tick after deploy. `cancel_reason` is NULL on
   * every pre-existing row and on every cancel that does not pass one, so
   * only cancels written by this code, after this deploy, are ever notified.
   */
  async pendingNotifications(): Promise<PendingNotification[]> {
    // ⚠️ LEFT join, keyed on the challenge's OWN target. An inner join would
    // drop every cancellation whose target never performed a pool emote —
    // no attempt row is written until the first one — and those are exactly
    // the players most stuck, so they would silently go untold.
    const rows = await this.db.select({
      challenge: verificationChallenges,
      progressIndex: challengeAttempts.progressIndex,
    })
      .from(verificationChallenges)
      .leftJoin(challengeAttempts, and(
        eq(challengeAttempts.challengeId, verificationChallenges.id),
        eq(challengeAttempts.dayzId, verificationChallenges.targetDayzId),
      ))
      .where(and(
        isNull(verificationChallenges.notifiedAt),
        or(
          isNotNull(verificationChallenges.completedAt),
          isNotNull(verificationChallenges.cancelReason),
        ),
      ));
    return rows.flatMap(({ challenge: r, progressIndex }): PendingNotification[] => {
      if (r.completedAt !== null) {
        // A completed row with no bound UID is unrepresentable
        // (verification_challenges_bound_requires_complete is the other half);
        // skip rather than assert so a notifier is never the thing that throws.
        return r.boundDayzId === null ? [] : [{ ...toLive(r), outcome: "completed" as const, boundDayzId: r.boundDayzId }];
      }
      return [{
        ...toLive(r),
        outcome: r.cancelReason as CancelReason,
        boundDayzId: null,
        progressIndex: progressIndex ?? 0,
      }];
    });
  }

  async markNotified(challengeId: number, at: Date): Promise<void> {
    await this.db.update(verificationChallenges)
      .set({ notifiedAt: at })
      .where(eq(verificationChallenges.id, challengeId));
  }

  /**
   * Cancel challenges that expired without completing, releasing the sequences
   * they hold. Without this the open-sequence index would treat a dead
   * challenge as a live competitor forever and slowly exhaust the pool.
   */
  async cancelExpired(now: Date): Promise<number> {
    const rows = await this.db.update(verificationChallenges)
      .set({ canceledAt: now })
      .where(and(
        isNull(verificationChallenges.completedAt),
        isNull(verificationChallenges.canceledAt),
        lt(verificationChallenges.expiresAt, now),
      ))
      .returning();
    return rows.length;
  }

  async cancelChallenge(challengeId: number, at: Date, reason?: CancelReason): Promise<boolean> {
    const rows = await this.db.update(verificationChallenges)
      .set({ canceledAt: at, cancelReason: reason ?? null })
      .where(and(
        eq(verificationChallenges.id, challengeId),
        isNull(verificationChallenges.completedAt),
        isNull(verificationChallenges.canceledAt),
      ))
      .returning();
    return rows.length > 0;
  }

  /**
   * ⚠️ LEFT join with an IS NULL filter, not `notInArray(subquery)`. The
   * exclusion must be evaluated by the database against the same snapshot as
   * the ordering; pulling the linked ids into memory first would let a link
   * committed between the two queries leak a taken character into the menu.
   */
  async recentUnlinkedPlayers(limit: number) {
    const rows = await this.db
      .select({ dayzId: players.dayzId, gamertag: players.gamertag })
      .from(players)
      .leftJoin(identityLinks, eq(identityLinks.dayzId, players.dayzId))
      .where(isNull(identityLinks.id))
      .orderBy(desc(players.lastSeenAt), desc(players.dayzId))
      .limit(limit);
    return rows;
  }

  async playerByDayzId(dayzId: string) {
    const [row] = await this.db
      .select({ dayzId: players.dayzId, gamertag: players.gamertag })
      .from(players).where(eq(players.dayzId, dayzId));
    return row ?? null;
  }
}

function toLive(row: typeof verificationChallenges.$inferSelect): LiveChallenge {
  return {
    id: row.id, discordId: row.discordId, guildId: row.guildId,
    channelId: row.channelId, sequence: row.sequence, issuedAt: row.issuedAt, expiresAt: row.expiresAt,
    targetDayzId: row.targetDayzId,
  };
}
