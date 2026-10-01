import type { Database } from "@factions/db";
import { events, feedEntries } from "@factions/db";
import type { LiveEntryKind, LivePayload } from "@factions/domain";
import { eq } from "drizzle-orm";
import { cursorFeedTick, type CursorFeedResult, type CursorFeedStore } from "./cursor-feed.js";
import type { KillFeedItem } from "./kill-feed-embed.js";
import type { HitFeedItem } from "./hit-feed-embed.js";
import type { KillstreakFeedItem } from "./killstreak-feed-embed.js";
import type { LongRangeFeedItem } from "./long-range-feed-embed.js";
import { isKillstreakMilestone } from "./killstreak-feed-tick.js";
import { toLiveHitRun, toLiveKill, toLiveLongRange, toLiveStreak } from "./live-payload.js";

/**
 * The website's copy of the four combat feeds (spec 2026-09-30-website-live-feeds).
 *
 * Each recorder runs its Discord feed's OWN store under a separate cursor, so
 * it records exactly what the poster would post, whether or not the poster
 * exists or is wedged on a channel permission. It writes a `feed_entries` row
 * instead of an embed.
 *
 * ⚠️ No seeding, except hits: the first run replays every kill, which is the
 * backfill. The store queries count tallies, bests and streaks up to and
 * including each kill, so a replayed row says what Discord said at the time.
 * Hits seed at the head: regrouping every historical hit event is the cost
 * the spec chose not to pay.
 *
 * ⚠️ At-least-once, like the posters. A crash between the insert and the cursor
 * write re-runs the item; `ON CONFLICT DO NOTHING` on (kind, source_event_id)
 * absorbs it.
 */
export const LIVE_RECORDER_CONSUMERS = {
  kill: "kill-feed-recorder",
  hit: "hit-feed-recorder",
  killstreak: "killstreak-feed-recorder",
  long_range: "long-range-feed-recorder",
} as const satisfies Record<LiveEntryKind, string>;

/** Bigger than the posters' 20: no rate limit on an insert, and the first run has history to chew through. */
export const LIVE_RECORDER_BATCH_SIZE = 100;

export type LiveRecord = { eventId: number; occurredAt: string; kind: LiveEntryKind; payload: LivePayload[LiveEntryKind] };

type Opts = { batchSize?: number; onError?: (eventId: number, err: unknown) => void };

export function insertFeedEntry(db: Database) {
  return async (r: LiveRecord): Promise<void> => {
    const [ev] = await db.select({ serverId: events.serverId }).from(events).where(eq(events.id, r.eventId));
    if (!ev) throw new Error(`feed entry source event ${r.eventId} not found`);
    await db.insert(feedEntries).values({
      serverId: ev.serverId, kind: r.kind, sourceEventId: r.eventId, occurredAt: new Date(r.occurredAt), payload: r.payload,
    }).onConflictDoNothing({ target: [feedEntries.kind, feedEntries.sourceEventId] });
  };
}

function record<T extends { eventId: number }>(
  db: Database, store: CursorFeedStore<T>, kind: LiveEntryKind,
  toRecord: (i: T) => LivePayload[LiveEntryKind] | null, seedAtHead: boolean, opts: Opts,
): Promise<CursorFeedResult> {
  return cursorFeedTick<T, LiveRecord>(store, insertFeedEntry(db), (i) => {
    const payload = toRecord(i);
    return payload === null ? null : { eventId: i.eventId, occurredAt: (payload as { occurredAt: string }).occurredAt, kind, payload };
  }, { batchSize: opts.batchSize ?? LIVE_RECORDER_BATCH_SIZE, onError: opts.onError, seedAtHead });
}

export const recordKills = (db: Database, store: CursorFeedStore<KillFeedItem>, opts: Opts = {}) =>
  record(db, store, "kill", toLiveKill, false, opts);

export const recordHits = (db: Database, store: CursorFeedStore<HitFeedItem>, opts: Opts = {}) =>
  record(db, store, "hit", (i) => (i.suppressed ? null : toLiveHitRun(i)), true, opts);

export const recordKillstreaks = (db: Database, store: CursorFeedStore<KillstreakFeedItem>, every: number, opts: Opts = {}) =>
  record(db, store, "killstreak", (i) => (isKillstreakMilestone(i, every) ? toLiveStreak(i) : null), false, opts);

export const recordLongRange = (db: Database, store: CursorFeedStore<LongRangeFeedItem>, opts: Opts = {}) =>
  record(db, store, "long_range", (i) => (i.qualifies ? toLiveLongRange(i) : null), false, opts);
