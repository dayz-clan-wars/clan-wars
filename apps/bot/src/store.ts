import type { Database } from "@factions/db";
import { identityLinks, verificationChallenges, challengeAttempts } from "@factions/db";
import { and, eq, gte, isNull, isNotNull, lt } from "drizzle-orm";

export type LiveChallenge = {
  id: number; discordId: string; guildId: string; channelId: string;
  sequence: string[]; issuedAt: Date; expiresAt: Date;
};
export type Attempt = { id: number; progressIndex: number; lastMatchedEventId: number; seenCount: number };

export interface VerificationStore {
  findLinkByDiscord(discordId: string): Promise<{ dayzId: string; gamertag: string; verifiedAt: Date } | null>;
  findLinkByDayzId(dayzId: string): Promise<{ discordId: string } | null>;
  deleteLinkByDiscord(discordId: string): Promise<boolean>;
  findLiveChallenge(discordId: string, now: Date): Promise<LiveChallenge | null>;
  liveChallenges(now: Date): Promise<LiveChallenge[]>;
  outstandingSequences(now: Date): Promise<string[][]>;
  createChallenge(input: { discordId: string; guildId: string; channelId: string; sequence: string[]; issuedAt: Date; expiresAt: Date }): Promise<LiveChallenge | null>;
  getAttempt(challengeId: number, dayzId: string): Promise<Attempt | null>;
  upsertAttempt(challengeId: number, dayzId: string, progressIndex: number, lastMatchedEventId: number, seenCount: number): Promise<void>;
  completeChallenge(challengeId: number, dayzId: string, gamertag: string, at: Date): Promise<boolean>;
  pendingNotifications(): Promise<Array<LiveChallenge & { boundDayzId: string }>>;
  markNotified(challengeId: number, at: Date): Promise<void>;
  cancelExpired(now: Date): Promise<number>;
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

  async findLiveChallenge(discordId: string, now: Date): Promise<LiveChallenge | null> {
    const [row] = await this.db.select().from(verificationChallenges)
      .where(and(eq(verificationChallenges.discordId, discordId), liveWhere(now)));
    return row ? toLive(row) : null;
  }

  async liveChallenges(now: Date): Promise<LiveChallenge[]> {
    const rows = await this.db.select().from(verificationChallenges).where(liveWhere(now));
    return rows.map(toLive);
  }

  async outstandingSequences(now: Date): Promise<string[][]> {
    return (await this.liveChallenges(now)).map((c) => c.sequence);
  }

  /**
   * Insert a challenge, or return null when another OPEN challenge already
   * holds this sequence. Null is an expected outcome — the caller redraws.
   */
  async createChallenge(input: {
    discordId: string; guildId: string; channelId: string;
    sequence: string[]; issuedAt: Date; expiresAt: Date;
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
   */
  async completeChallenge(challengeId: number, dayzId: string, gamertag: string, at: Date): Promise<boolean> {
    return this.db.transaction(async (tx) => {
      const [challenge] = await tx.select().from(verificationChallenges)
        .where(eq(verificationChallenges.id, challengeId));
      if (!challenge) return false;

      const cancel = async () => {
        await tx.update(verificationChallenges)
          .set({ canceledAt: at })
          .where(eq(verificationChallenges.id, challengeId));
        return false;
      };

      const complete = async () => {
        // completed_at and bound_dayz_id are set in ONE statement: the schema
        // forbids a bound row that is not complete.
        await tx.update(verificationChallenges)
          .set({ completedAt: at, boundDayzId: dayzId })
          .where(eq(verificationChallenges.id, challengeId));
        return true;
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

  async pendingNotifications(): Promise<Array<LiveChallenge & { boundDayzId: string }>> {
    const rows = await this.db.select().from(verificationChallenges).where(and(
      isNotNull(verificationChallenges.completedAt),
      isNull(verificationChallenges.notifiedAt),
    ));
    return rows.filter((r) => r.boundDayzId !== null).map((r) => ({ ...toLive(r), boundDayzId: r.boundDayzId! }));
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
}

function toLive(row: typeof verificationChallenges.$inferSelect): LiveChallenge {
  return {
    id: row.id, discordId: row.discordId, guildId: row.guildId,
    channelId: row.channelId, sequence: row.sequence, issuedAt: row.issuedAt, expiresAt: row.expiresAt,
  };
}
