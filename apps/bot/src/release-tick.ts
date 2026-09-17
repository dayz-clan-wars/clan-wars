import { asc, eq, isNull } from "drizzle-orm";
import { releaseAnnouncements, type Database } from "@factions/db";
import type { FeedPoster } from "./feed-tick.js";
import { releaseEmbeds } from "./release-text.js";

export interface QueuedRelease {
  id: number;
  version: string;
  title: string | null;
  body: string;
  releasedAt: Date;
}

export interface ReleaseStore {
  readOldestUnposted(): Promise<QueuedRelease | null>;
  markPosted(id: number, at: Date): Promise<void>;
}

export type ReleaseTickResult = {
  posted: number;
  /** The id of the row that failed, or null if nothing blocked. */
  blockedAt: number | null;
};

export function pgReleaseStore(db: Database): ReleaseStore {
  return {
    readOldestUnposted: async () => {
      const [row] = await db.select({
        id: releaseAnnouncements.id,
        version: releaseAnnouncements.version,
        title: releaseAnnouncements.title,
        body: releaseAnnouncements.body,
        releasedAt: releaseAnnouncements.releasedAt,
      })
        .from(releaseAnnouncements)
        .where(isNull(releaseAnnouncements.postedAt))
        .orderBy(asc(releaseAnnouncements.id))
        .limit(1);
      return row ?? null;
    },
    markPosted: async (id, at) => {
      await db.update(releaseAnnouncements)
        .set({ postedAt: at })
        .where(eq(releaseAnnouncements.id, id));
    },
  };
}

/**
 * Post the oldest unannounced release, one per tick.
 *
 * ⚠️ ONE row per tick, unlike `warLogTick`'s batch of 20. The first run after a
 * backfill has 25 rows behind it, and at `BOT_TICK_INTERVAL_MS` this spreads
 * them over minutes instead of dumping them into the channel at once. In steady
 * state there is never more than one row, so the pacing costs nothing.
 *
 * ⚠️ Post first, mark second, and a failure BLOCKS rather than skipping ahead —
 * the same contract as `feedTick` and `warLogTick`, for the same reason: a
 * retried older release landing below a newer one makes the channel stop being
 * a history. At-least-once, so a crash between the post and the mark re-posts.
 */
export async function releaseTick(
  store: ReleaseStore,
  post: FeedPoster,
  opts: { now: Date; onError?: (id: number, err: unknown) => void },
): Promise<ReleaseTickResult> {
  const row = await store.readOldestUnposted();
  if (row === null) return { posted: 0, blockedAt: null };

  try {
    // ⚠️ Sequential, not Promise.all: the pieces of a split release must land
    // in order, and Discord does not guarantee ordering across concurrent sends.
    for (const embed of releaseEmbeds(row)) {
      await post(embed);
    }
  } catch (err) {
    opts.onError?.(row.id, err);
    return { posted: 0, blockedAt: row.id };
  }

  await store.markPosted(row.id, opts.now);
  return { posted: 1, blockedAt: null };
}
