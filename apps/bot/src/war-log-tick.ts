import type { WarLogStore } from "@factions/roster/internal";
import { warLogText } from "./war-log-text.js";

export type WarLogPoster = (content: string) => Promise<void>;

export type WarLogTickResult = {
  posted: number;
  /** The id of the row that ended the run, or null if the queue drained. See feedTick's comment. */
  blockedAt: number | null;
};

export const WAR_LOG_BATCH_SIZE = 20;

/**
 * Post queued `war_log_events` rows to #war-log, oldest first — a copy of
 * `feedTick` over `WarLogStore` (see feed-tick.ts for the reasoning: post
 * then mark, and the first failure ends the run rather than skipping ahead,
 * so the channel stays a chronological record).
 *
 * ⚠️ At-least-once, like every poster here: post-then-mark means a crash
 * between the two re-posts that row on the next start. See notice-tick.ts.
 */
export async function warLogTick(
  store: WarLogStore,
  post: WarLogPoster,
  opts: { now: Date; siteBaseUrl: string; batchSize?: number; onError?: (id: number, err: unknown) => void },
): Promise<WarLogTickResult> {
  const out: WarLogTickResult = { posted: 0, blockedAt: null };

  for (const row of await store.readUnposted(opts.batchSize ?? WAR_LOG_BATCH_SIZE)) {
    try {
      await post(warLogText(row, opts.siteBaseUrl));
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
