import type { Database } from "@factions/db";
import { identityLinks, verificationChallenges, challengeAttempts } from "@factions/db";
import { and, eq, gte, isNull, isNotNull } from "drizzle-orm";

export type LiveChallenge = {
  id: number; discordId: string; guildId: string; channelId: string;
  sequence: string[]; expiresAt: Date;
};
export type Attempt = { id: number; progressIndex: number; lastMatchedEventId: number };

export interface VerificationStore {
  findLinkByDiscord(discordId: string): Promise<{ dayzId: string; gamertag: string; verifiedAt: Date } | null>;
  findLinkByDayzId(dayzId: string): Promise<{ discordId: string } | null>;
  deleteLinkByDiscord(discordId: string): Promise<boolean>;
  findLiveChallenge(discordId: string, now: Date): Promise<LiveChallenge | null>;
  liveChallenges(now: Date): Promise<LiveChallenge[]>;
  outstandingSequences(now: Date): Promise<string[][]>;
  createChallenge(input: { discordId: string; guildId: string; channelId: string; sequence: string[]; issuedAt: Date; expiresAt: Date }): Promise<LiveChallenge>;
  getAttempt(challengeId: number, dayzId: string): Promise<Attempt | null>;
  upsertAttempt(challengeId: number, dayzId: string, progressIndex: number, lastMatchedEventId: number): Promise<void>;
  completeChallenge(challengeId: number, dayzId: string, gamertag: string, at: Date): Promise<boolean>;
  pendingNotifications(): Promise<Array<LiveChallenge & { boundDayzId: string }>>;
  markNotified(challengeId: number, at: Date): Promise<void>;
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

  async createChallenge(input: {
    discordId: string; guildId: string; channelId: string;
    sequence: string[]; issuedAt: Date; expiresAt: Date;
  }): Promise<LiveChallenge> {
    const [row] = await this.db.insert(verificationChallenges).values(input).returning();
    return toLive(row!);
  }

  async getAttempt(challengeId: number, dayzId: string): Promise<Attempt | null> {
    const [row] = await this.db.select().from(challengeAttempts)
      .where(and(eq(challengeAttempts.challengeId, challengeId), eq(challengeAttempts.dayzId, dayzId)));
    return row ? { id: row.id, progressIndex: row.progressIndex, lastMatchedEventId: row.lastMatchedEventId } : null;
  }

  async upsertAttempt(challengeId: number, dayzId: string, progressIndex: number, lastMatchedEventId: number): Promise<void> {
    await this.db.insert(challengeAttempts)
      .values({ challengeId, dayzId, progressIndex, lastMatchedEventId })
      .onConflictDoUpdate({
        target: [challengeAttempts.challengeId, challengeAttempts.dayzId],
        set: { progressIndex, lastMatchedEventId },
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
      const [taken] = await tx.select().from(identityLinks).where(eq(identityLinks.dayzId, dayzId));
      const [challenge] = await tx.select().from(verificationChallenges)
        .where(eq(verificationChallenges.id, challengeId));
      if (!challenge) return false;

      if (taken && taken.discordId !== challenge.discordId) {
        await tx.update(verificationChallenges)
          .set({ canceledAt: at })
          .where(eq(verificationChallenges.id, challengeId));
        return false;
      }

      await tx.insert(identityLinks)
        .values({ discordId: challenge.discordId, dayzId, gamertag, verifiedAt: at })
        .onConflictDoNothing();
      await tx.update(verificationChallenges)
        .set({ completedAt: at, boundDayzId: dayzId })
        .where(eq(verificationChallenges.id, challengeId));
      return true;
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
}

function toLive(row: typeof verificationChallenges.$inferSelect): LiveChallenge {
  return {
    id: row.id, discordId: row.discordId, guildId: row.guildId,
    channelId: row.channelId, sequence: row.sequence, expiresAt: row.expiresAt,
  };
}
