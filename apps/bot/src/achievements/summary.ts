import { achievementUnlocks, clanNotices, identityLinks, type Database } from "@factions/db";
import type { AchievementKey } from "@factions/domain";
import { noticeUserTx } from "@factions/roster/internal";
import { and, asc, eq, inArray, lt, sql } from "drizzle-orm";
import { profileUrl } from "../site-links.js";
import { namesFor } from "./tick.js";

/** A release whose new tiles were backfilled silently. One key per release, so a later one gets its own summary. */
export type SummaryRelease = "2026-10";

export type SummaryOpts = {
  release: SummaryRelease;
  /** The release's new tiles (`ACHIEVEMENTS_2026_10`). */
  keys: readonly AchievementKey[];
  /** The release instant. Only unlocks earned BEFORE it count: those are the ones the backfill credited silently. */
  before: Date;
  siteBaseUrl: string;
  /** Count what would be queued, write nothing. */
  dryRun?: boolean;
};

/**
 * One DM per linked player after a release's silent backfill (spec
 * 2026-10-20-achievements-150): "You already hold 3 of the new achievements." The
 * backfill runs with `announce: false`, so without this a player would never hear
 * about tiles history gave them; announcing each one would be dozens of DMs apiece.
 *
 * ⚠️ DM only — never the public #achievements wall or a clan channel. That is the
 * point of summarising: the history is not news to anyone else.
 *
 * ⚠️ `earned_at < before`: a tile earned after the release was earned live, and the
 * live tick already announced it. A player whose only new tiles are live gets nothing.
 *
 * ⚠️ Idempotent per (Discord id, release) against `clan_notices`: running it twice
 * queues nothing new, and the queued row IS the record that the summary was sent —
 * deleting it sends it again.
 *
 * Unlinked players get nothing: there is nobody to DM. A player who links later is
 * not caught up by this; the wall already shows them their tiles.
 */
export async function queueAchievementSummaries(db: Database, opts: SummaryOpts): Promise<{ queued: number; skipped: number }> {
  const result = { queued: 0, skipped: 0 };
  if (opts.keys.length === 0) return result;
  // Per linked player: how many of the release's tiles they hold from before it.
  // The inner join on identity_links is what drops the unlinked.
  const rows = await db
    .select({
      dayzId: achievementUnlocks.ownerId, discordId: identityLinks.discordId, gamertag: identityLinks.gamertag,
      count: sql<number>`count(*)::int`,
    })
    .from(achievementUnlocks)
    .innerJoin(identityLinks, eq(identityLinks.dayzId, achievementUnlocks.ownerId))
    .where(and(eq(achievementUnlocks.ownerKind, "player"), inArray(achievementUnlocks.key, [...opts.keys]), lt(achievementUnlocks.earnedAt, opts.before)))
    .groupBy(achievementUnlocks.ownerId, identityLinks.discordId, identityLinks.gamertag)
    .orderBy(asc(identityLinks.discordId));

  for (const r of rows) {
    // namesFor's server pick: `server_id` is a FK on clan_notices, and a DM still needs one.
    const serverId = opts.dryRun ? 0 : (await namesFor(db, { kind: "player", id: r.dayzId })).serverId;
    const queued = await db.transaction(async (tx) => {
      // ⚠️ Check and insert under one advisory lock, so two runs started together (two
      // operators, a retried ssh) cannot both see "not sent" and both queue.
      if (!opts.dryRun) await tx.execute(sql`select pg_advisory_xact_lock(hashtext('achievement_summary'))`);
      const [already] = await tx.select({ id: clanNotices.id }).from(clanNotices)
        .where(and(eq(clanNotices.kind, "achievement_summary"), eq(clanNotices.target, "dm"), eq(clanNotices.discordTargetId, r.discordId),
          sql`${clanNotices.payload}->>'release' = ${opts.release}`))
        .limit(1);
      if (already) return false;
      if (opts.dryRun) return true;
      await noticeUserTx(tx, {
        serverId, factionId: null, discordId: r.discordId, kind: "achievement_summary", occurredAt: new Date(),
        payload: { release: opts.release, count: r.count, gamertag: r.gamertag, wallUrl: `${profileUrl(opts.siteBaseUrl, r.gamertag)}#achievements` },
      });
      return true;
    });
    if (queued) result.queued += 1; else result.skipped += 1;
  }
  return result;
}
