import type { APIEmbed } from "discord.js";
import type { FeedStore } from "./feed-store.js";
import { feedEmbed, type FlagImageResolver } from "./feed-embed.js";

export type FeedPoster = (embed: APIEmbed) => Promise<void>;

export type FeedTickResult = {
  posted: number;
  /**
   * The id of the row that ended the run, or null if the queue drained.
   *
   * A value here means the queue is BLOCKED, not merely that one post
   * failed — every row behind it waits. See the stop-on-failure comment.
   */
  blockedAt: number | null;
};

/**
 * Enough to drain a normal backlog in one tick, small enough that a long
 * outage's queue does not hold the shared runner through hundreds of posts
 * while verification and the dormancy clock wait behind it.
 */
export const FEED_BATCH_SIZE = 20;

/**
 * Post queued transitions to the feed channel, oldest first.
 *
 * ⚠️ Post, THEN mark. At-least-once, matching `notifyCompleted`: a crash in
 * the window duplicates one post, and the alternative loses it permanently.
 * A public record that silently gains holes is worse than one that
 * occasionally stutters, and the single-instance rule in CLAUDE.md is what
 * bounds the duplicate risk.
 *
 * ⚠️ The first failure ENDS the run — the loop does not skip to the next
 * row. Skipping would let a retried older event appear below newer ones, so
 * a channel read top-down would show "disbanded" above the "dormant" that
 * preceded it. One stuck row blocking the queue is the correct trade: the
 * blockage is reported loudly through `onError` and `blockedAt`, and the
 * alternative is silent corruption of the history.
 */
export async function feedTick(
  store: FeedStore,
  post: FeedPoster,
  opts: {
    now: Date;
    batchSize?: number;
    flagImage?: FlagImageResolver;
    onError?: (id: number, err: unknown) => void;
  },
): Promise<FeedTickResult> {
  const out: FeedTickResult = { posted: 0, blockedAt: null };

  for (const row of await store.readUnposted(opts.batchSize ?? FEED_BATCH_SIZE)) {
    try {
      await post(feedEmbed(row, opts.flagImage));
      // ⚠️ Guard markPosted in the same block as post: if it fails, the row's
      // postedAt stays null and re-posts on the next tick. An unguarded failure
      // floods the channel with the same embed forever, which is worse than
      // the blocked queue the design accepts — here, we report loudly and stop.
      await store.markPosted(row.id, opts.now);
    } catch (err) {
      opts.onError?.(row.id, err);
      out.blockedAt = row.id;
      return out;
    }
    out.posted++;
  }

  return out;
}
