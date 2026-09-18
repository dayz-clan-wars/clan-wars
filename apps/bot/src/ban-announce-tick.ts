import { and, asc, eq, isNull } from "drizzle-orm";
import { banAnnouncements, type Database } from "@factions/db";
import { banAnnouncementText, type BanAnnouncement } from "./ban-announce-text.js";

export type BanAnnouncePoster = (content: string) => Promise<void>;

export type BanAnnounceTickResult = {
  posted: number;
  /** The id of the row that ended the run, or null if the queue drained. See feedTick's comment. */
  blockedAt: number | null;
};

export const BAN_ANNOUNCE_BATCH_SIZE = 20;

/**
 * Post queued `ban_announcements` rows to the public #bans channel, oldest
 * first — a copy of `warLogTick` over `ban_announcements` (see feed-tick.ts
 * for the reasoning: post then mark, and the first failure ends the run
 * rather than skipping ahead, so the channel stays a chronological record).
 *
 * ⚠️ At-least-once, like every poster here: post-then-mark means a crash
 * between the two re-posts that row on the next start. See notice-tick.ts.
 * The alternative — mark then post — silently drops a ban from the public
 * record on the same crash, which is worse for a channel whose whole point
 * is to be a complete record of real, enforced bans.
 *
 * ⚠️ The first failure ENDS the run — the loop does not skip to the next
 * row. Skipping would let a retried older ban land below a newer one in the
 * channel, and a public record whose order cannot be trusted is not a
 * record. See feed-tick.ts.
 */
export async function banAnnounceTick(
  db: Database,
  post: BanAnnouncePoster,
  opts: { now: Date; serverId: number; batchSize?: number; onError?: (id: number, err: unknown) => void },
): Promise<BanAnnounceTickResult> {
  const out: BanAnnounceTickResult = { posted: 0, blockedAt: null };

  const rows = await db.select().from(banAnnouncements).where(and(
    eq(banAnnouncements.serverId, opts.serverId),
    isNull(banAnnouncements.postedAt),
  )).orderBy(asc(banAnnouncements.id)).limit(opts.batchSize ?? BAN_ANNOUNCE_BATCH_SIZE);

  for (const row of rows) {
    try {
      await post(banAnnouncementText(row.payload as BanAnnouncement));
      await db.update(banAnnouncements).set({ postedAt: opts.now }).where(eq(banAnnouncements.id, row.id));
    } catch (err) {
      opts.onError?.(row.id, err);
      out.blockedAt = row.id;
      return out;
    }
    out.posted++;
  }

  return out;
}
