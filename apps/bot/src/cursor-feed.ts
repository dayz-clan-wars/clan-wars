import type { APIEmbed } from "discord.js";

export type CursorFeedPoster = (embed: APIEmbed) => Promise<void>;

/** What a feed reads and writes. `T` is one postable unit — a kill, an engagement, a milestone. */
export type CursorFeedStore<T> = {
  /** Whether the cursor row exists at all. */
  seeded(): Promise<boolean>;
  /** The newest candidate's event id, or 0 when there are none. */
  head(): Promise<number>;
  cursor(): Promise<number>;
  /** Candidates after `cursor`, oldest first. Includes items the render will decline. */
  readAfter(cursor: number, limit: number): Promise<T[]>;
  markPosted(eventId: number): Promise<void>;
};

/**
 * One item to one embed, or `null` to decline it.
 *
 * ⚠️ Declining is DECIDING, not deferring: the loop advances the cursor past a
 * declined item. That is what lets a store hand back every candidate in id
 * order — a friendly-fire kill, a short-range kill, an engagement a kill
 * already claimed — and let a pure function apply the rule, without the cursor
 * stalling on a run of items nobody wants.
 */
export type CursorFeedRender<T> = (item: T) => APIEmbed | null;

export type CursorFeedResult = {
  posted: number;
  /** The event id that ended the run, or null if the queue drained. */
  blockedAt: number | null;
  /** True on the run that created the cursor at the head, posting nothing. */
  seeded: boolean;
};

export const DEFAULT_FEED_BATCH_SIZE = 20;

/**
 * The shape every Discord feed in this bot shares: post oldest first, advance
 * the cursor after each success, and let the FIRST failure end the run so the
 * channel stays chronological.
 *
 * ⚠️ The FIRST run seeds the cursor at the head and posts nothing. `kills` and
 * `events` hold history (58 backfilled kills on launch day alone), and a
 * Discord poster that replays history announces last week to a public channel.
 * This is the opposite default to the stats projectors, which are deliberately
 * unseeded so they DO replay — they write rows, not messages.
 *
 * ⚠️ At-least-once: a crash between the post and the cursor write re-posts that
 * item on the next start. See notice-tick.ts.
 */
export async function cursorFeedTick<T extends { eventId: number }>(
  store: CursorFeedStore<T>,
  post: CursorFeedPoster,
  render: CursorFeedRender<T>,
  opts: { batchSize?: number; onError?: (eventId: number, err: unknown) => void } = {},
): Promise<CursorFeedResult> {
  const out: CursorFeedResult = { posted: 0, blockedAt: null, seeded: false };

  if (!(await store.seeded())) {
    await store.markPosted(await store.head());
    out.seeded = true;
    return out;
  }

  const cursor = await store.cursor();
  for (const item of await store.readAfter(cursor, opts.batchSize ?? DEFAULT_FEED_BATCH_SIZE)) {
    const embed = render(item);
    if (embed === null) {
      await store.markPosted(item.eventId);
      continue;
    }
    try {
      await post(embed);
      await store.markPosted(item.eventId);
    } catch (err) {
      opts.onError?.(item.eventId, err);
      out.blockedAt = item.eventId;
      return out;
    }
    out.posted++;
  }
  return out;
}
