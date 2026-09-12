import { achievementUnlocks, clanNotices, type Database } from "@factions/db";
import { and, asc, eq, sql } from "drizzle-orm";
import type { AchievementKey } from "@factions/domain";
import { namesFor, queueUnlockNoticesTx, type NoticeTargets } from "./tick.js";
import type { Owner } from "./types.js";

export type BackfillNoticesOpts = { achievementsChannelId?: string; targets: NoticeTargets; dryRun?: boolean; onError?: (owner: Owner, key: AchievementKey, err: unknown) => void };
export type BackfillNoticesResult = { unlocks: number; queued: number; skipped: number; failed: number };

/**
 * Announce the unlocks the first backfill inserted silently (announce:false),
 * in the order they were earned. One transaction per unlock, in `earned_at`
 * order, so the rows' ids — which is the order the notice poster reads a
 * target in — follow the history.
 *
 * ⚠️ Idempotent by (owner, key) against `clan_notices`: an unlock that already
 * has ANY achievement notice is skipped, whether the live tick queued it or a
 * previous run of this did. Running it twice queues nothing new; running it
 * after the live tick has been on for a while announces only what the tick
 * never saw.
 *
 * ⚠️ Names are resolved NOW, not at earning time — the same as the live tick,
 * which also names the owner at unlock time, never later. A player who has
 * since changed clans is announced with their current clan.
 */
export async function backfillAchievementNotices(db: Database, opts: BackfillNoticesOpts): Promise<BackfillNoticesResult> {
  const result: BackfillNoticesResult = { unlocks: 0, queued: 0, skipped: 0, failed: 0 };
  const unlocks = await db.select({ ownerKind: achievementUnlocks.ownerKind, ownerId: achievementUnlocks.ownerId, key: achievementUnlocks.key, earnedAt: achievementUnlocks.earnedAt })
    .from(achievementUnlocks).orderBy(asc(achievementUnlocks.earnedAt), asc(achievementUnlocks.key));
  result.unlocks = unlocks.length;
  const names = new Map<string, Awaited<ReturnType<typeof namesFor>>>();
  for (const u of unlocks) {
    const owner: Owner = { kind: u.ownerKind as Owner["kind"], id: u.ownerId };
    const key = u.key as AchievementKey;
    try {
      const [already] = await db.select({ id: clanNotices.id }).from(clanNotices)
        .where(and(eq(clanNotices.kind, "achievement"), sql`${clanNotices.payload}->>'key' = ${key}`, sql`${clanNotices.payload}->>'ownerKind' = ${owner.kind}`, sql`${clanNotices.payload}->>'ownerId' = ${owner.id}`)).limit(1);
      if (already) { result.skipped += 1; continue; }
      const ownerKey = `${owner.kind}:${owner.id}`;
      let n = names.get(ownerKey);
      if (!n) { n = await namesFor(db, owner); names.set(ownerKey, n); }
      if (opts.dryRun) { result.queued += 1; continue; }
      await db.transaction((tx) => queueUnlockNoticesTx(tx, { owner, key, earnedAt: u.earnedAt, names: n, achievementsChannelId: opts.achievementsChannelId, targets: opts.targets }));
      result.queued += 1;
    } catch (err) {
      result.failed += 1;
      opts.onError?.(owner, key, err);
    }
  }
  return result;
}
