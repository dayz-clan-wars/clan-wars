import type { Database } from "@factions/db";
import { consumerCursors, events, factions, kills, players } from "@factions/db";
import { readCursor, writeCursor } from "@factions/event-log";
import { DEFAULT_HIT_BURST_WINDOW_S, RECENT_HIT_WINDOW_S, groupHitBursts, type HitEngagement, type HitInput } from "@factions/domain";
import { and, asc, eq, gt, gte, lte, max, min, sql } from "drizzle-orm";
import { cursorFeedTick, type CursorFeedPoster, type CursorFeedResult, type CursorFeedStore } from "./cursor-feed.js";
import type { FlagImageResolver } from "./feed-embed.js";
import { hitFeedEmbed, type HitFeedItem } from "./hit-feed-embed.js";
import { KILLS_CONSUMER } from "./kills-tick.js";
import { membershipAt } from "./membership-tick.js";

/** ⚠️ Distinct from every other consumer name. Its value is the `events.id` of the last engagement's last hit. */
export const HIT_FEED_CONSUMER = "hit-feed-poster";

/**
 * Post closed PvP engagements to #hit-feed. An engagement a kill claimed is
 * declined by the render — it belongs to #kill-feed — while still advancing
 * the cursor, because it is decided, not pending.
 */
export function hitFeedTick(
  store: CursorFeedStore<HitFeedItem>,
  post: CursorFeedPoster,
  opts: { siteBaseUrl: string; flagImage?: FlagImageResolver; batchSize?: number; onError?: (eventId: number, err: unknown) => void },
): Promise<CursorFeedResult> {
  return cursorFeedTick(store, post, (i) => (i.suppressed ? null : hitFeedEmbed(i, opts.siteBaseUrl, opts.flagImage)), {
    batchSize: opts.batchSize,
    onError: opts.onError,
  });
}

const num = (v: unknown): number | null => (typeof v === "number" ? v : null);
const str = (v: unknown): string | null => (typeof v === "string" ? v : null);

/**
 * The query `readAfter` runs to find candidate hit events. Exported, not
 * inlined, so `hit-feed-index-drift.test.ts` can `EXPLAIN` the exact query
 * this store issues rather than a hand-copied lookalike that could drift from
 * it. `events_hit_id_idx` is the partial index (`packages/db/src/schema.ts`)
 * that keeps the `id` range scan from walking to the end of `events` every
 * tick once the frontier lags.
 */
export function hitEventsQuery(db: Database, cursor: number, frontier: Date) {
  return db.select({ id: events.id, serverId: events.serverId, occurredAt: events.occurredAt, payload: events.payload })
    .from(events)
    .where(and(gt(events.id, cursor), eq(events.type, "player.hit"), lte(events.occurredAt, frontier)))
    .orderBy(asc(events.id));
}

/**
 * `frontier()`'s steady-state fallback — the query it runs on every tick
 * where the kills projector is caught up (most of them). Exported for the
 * same reason as `hitEventsQuery`: `hit-feed-index-drift.test.ts` pins the
 * actual query, not a lookalike. `events_occurred_idx` (plain, unqualified)
 * is what answers it; `events_server_occurred_idx` cannot, since it is keyed
 * on `server_id` first.
 */
export function maxOccurredAtQuery(db: Database) {
  return db.select({ at: max(events.occurredAt) }).from(events);
}

export class PgHitFeedStore implements CursorFeedStore<HitFeedItem> {
  private readonly windowS: number;
  constructor(private readonly db: Database, opts: { windowS?: number } = {}) {
    this.windowS = opts.windowS ?? DEFAULT_HIT_BURST_WINDOW_S;
  }

  async seeded(): Promise<boolean> {
    const [row] = await this.db.select({ n: consumerCursors.lastEventId }).from(consumerCursors)
      .where(eq(consumerCursors.consumerName, HIT_FEED_CONSUMER));
    return row !== undefined;
  }

  async head(): Promise<number> {
    const [row] = await this.db.select({ n: sql<number>`coalesce(max(${events.id}), 0)::bigint` })
      .from(events).where(eq(events.type, "player.hit"));
    return Number(row?.n ?? 0);
  }

  cursor(): Promise<number> {
    return readCursor(this.db, HIT_FEED_CONSUMER);
  }

  markPosted(eventId: number): Promise<void> {
    return writeCursor(this.db, HIT_FEED_CONSUMER, eventId);
  }

  /**
   * ⚠️ "Now" for the closing test, and it is NOT the wall clock, and it is NOT
   * simply "the `occurred_at` of the row the kills cursor names" either — that
   * row can be hand-deleted (this repo's documented fix for a misparsed
   * line), and a reparse backfills events at the HEAD of the log with their
   * true, OLD `occurred_at`, so id order and time order can disagree. Relying
   * on one named row's own timestamp breaks under either.
   *
   * Instead: `F` is the smallest `occurred_at` among events the kills
   * projector has NOT yet reached (`id > killsCursor`), minus a millisecond so
   * the boundary event itself is excluded. That is true regardless of row
   * deletions or id/time reordering: every event with `occurred_at <= F` is,
   * by construction, at an id the kills projector has already passed, so its
   * `kills` row (if any) already exists. When nothing is unprocessed — the
   * projector is caught up — `F` falls back to the newest known `occurred_at`
   * across all events, which is "now" as far as this feed can tell.
   *
   * On an empty events table this returns null, which means nothing closes —
   * correct, there is nothing to be caught up on.
   */
  private async frontier(): Promise<Date | null> {
    const killsCursor = await readCursor(this.db, KILLS_CONSUMER);
    const [unseen] = await this.db.select({ at: min(events.occurredAt) }).from(events).where(gt(events.id, killsCursor));
    if (unseen?.at != null) return new Date(unseen.at.getTime() - 1);
    const [seen] = await maxOccurredAtQuery(this.db);
    return seen?.at ?? null;
  }

  async readAfter(cursor: number, limit: number): Promise<HitFeedItem[]> {
    const frontier = await this.frontier();
    if (frontier === null) return [];

    // ⚠️ Read more rows than engagements wanted: one engagement is many hits,
    // and a burst cut in half by the row limit would be posted twice.
    const rows = await hitEventsQuery(this.db, cursor, frontier).limit(limit * 50);

    if (rows.length === 0) return [];

    // ⚠️ When the row limit truncated the read, the effective frontier is the
    // last row we actually saw, minus a millisecond: everything AT OR PAST it
    // is unknown, and a burst judged quiet against a frontier we did not read
    // up to is a burst that may still be running. Strictly less-than, not
    // equal, because `settle` is only guaranteed greater than `windowS` at the
    // default; a `HIT_BURST_WINDOW_S` of 120 or more would make them equal
    // and erase the headroom this truncation guard depends on.
    const truncated = rows.length === limit * 50;
    const effective = truncated ? new Date(rows[rows.length - 1]!.occurredAt.getTime() - 1) : frontier;

    const inputs: HitInput[] = [];
    for (const r of rows) {
      const p = r.payload as Record<string, unknown>;
      const type = p.attackerType;
      const victimDayzId = str(p.victimDayzId);
      // A hit with no victim id is unusable — grouping it under "" would
      // merge every such hit from one attacker into a single fake engagement.
      if (victimDayzId === null) continue;
      inputs.push({
        eventId: Number(r.id), serverId: r.serverId, occurredAt: r.occurredAt,
        attackerType: type === "player" || type === "infected" ? type : "environment",
        attackerDayzId: str(p.attackerDayzId), victimDayzId,
        weapon: str(p.weapon), damage: num(p.damage), bodyPart: str(p.bodyPart),
        distanceM: num(p.distanceM), victimHp: num(p.victimHp),
      });
    }

    const engagements = groupHitBursts(inputs, { frontier: effective, windowS: this.windowS });

    // ⚠️ The cursor is a single global watermark, but `groupHitBursts` hands
    // back engagements in FIRST-event order, not last-event order — two
    // interleaved fights can close with their last event ids in either
    // relative order. Emitting by first-event order (or by each engagement's
    // own lastEventId unsorted) can hand the loop a descending pair, and
    // `writeCursor` is an unconditional set: the cursor would move backward
    // and the earlier fight would be posted again as a mangled fragment.
    //
    // ⚠️ It is NOT enough to guard against OPEN engagements alone. A closed
    // engagement that is itself withheld (because emitting it would already
    // violate this same rule) is just as much an obstacle as an open one: its
    // early hits are just as unposted, and stepping the cursor past them
    // buries them exactly the same way. So the barrier for candidate X is not
    // "the smallest firstEventId among open engagements" — it is the smallest
    // firstEventId among every engagement that ends up NOT emitted this tick,
    // open or withheld-closed alike, excluding X itself.
    //
    // ⚠️ Computing that safe set is a FIXED POINT, not a single sorted pass.
    // A withheld engagement's own firstEventId can retroactively disqualify
    // an EARLIER-lastEventId candidate that looked safe against a barrier
    // computed before that withholding was known — e.g. two engagements whose
    // spans nest (one's hits entirely surrounding the other's), both fully
    // closed, neither open: checked in isolation each looks fine, but the
    // outer one's lastEventId sits inside the inner one's span. Treat opens
    // as the initial obstacle set; repeatedly move any not-yet-decided closed
    // engagement whose lastEventId is not below the current barrier into the
    // obstacle set (recomputing the barrier each pass) until a pass makes no
    // change. Batches here are small, so this straightforward, repeated-pass
    // approach is preferred over a cleverer single-scan one.
    //
    // ⚠️ `limit` takes part in that fixed point — it is NOT a slice applied
    // after it converges. An engagement dropped by a trailing slice is
    // neither emitted nor an obstacle, so it was never tested against, which
    // reopens the exact hole the fixed point closes: closed X1(1st 10, last
    // 11), X2(1st 12, last 13), Y(1st 1, last 100) with limit 2 would emit X1
    // and X2, land the cursor on 13, and bury Y's hits at ids 1-9 — Y then
    // re-groups as a fragment, posting "4 hits, 152 damage" as "1 hit, 38
    // damage" with a wrong start time. Silent and permanent. So the dropped
    // tail joins the obstacles and the passes run again.
    //
    // Termination: `obstacles` only ever grows and `candidates` only ever
    // shrinks — nothing is returned to `candidates` once withheld — so every
    // pass that sets `changed` strictly decreases a non-negative integer.
    // At most one pass per engagement, then it stops. It cannot cycle.
    const byLast = (a: HitEngagement, b: HitEngagement) => a.lastEventId - b.lastEventId;
    const open = engagements.filter((e) => !e.closed);
    const allClosed = engagements.filter((e) => e.closed).sort(byLast);

    const settle = (cap: number): HitEngagement[] => {
      const obstacles = [...open];
      let candidates = [...allClosed];
      for (let changed = true; changed; ) {
        changed = false;
        const barrier = obstacles.length > 0 ? Math.min(...obstacles.map((e) => e.firstEventId)) : Infinity;
        const stillCandidates: HitEngagement[] = [];
        for (const c of candidates) {
          if (c.lastEventId >= barrier) {
            obstacles.push(c);
            changed = true;
          } else {
            stillCandidates.push(c);
          }
        }
        candidates = stillCandidates;
        if (candidates.length > cap) {
          obstacles.push(...candidates.slice(cap));
          candidates = candidates.slice(0, cap);
          changed = true;
        }
      }
      return candidates;
    };

    // ⚠️ `settle(limit)` is the LARGEST safe set of at most `limit`
    // engagements, but "largest" can be zero even with nothing open at all:
    // when the safe set's spans nest, a prefix shorter than the whole thing
    // is unsafe, and if the whole thing is longer than `limit` then no
    // admissible set exists. Emitting nothing there is not caution, it is a
    // permanent stall — the same rows re-read every tick, the same answer,
    // forever, with no open engagement that will ever close to break it. So
    // when the limited fixed point comes back empty, fall back to the
    // SMALLEST non-empty safe prefix and overshoot `limit` deliberately.
    // `limit` is a batch-size hint bounded by the rows already read; the
    // cursor invariant is not negotiable, and liveness beats the hint.
    //
    // (Every safe set is a prefix in lastEventId order: if some un-emitted g
    // had g.lastEventId below the largest emitted lastEventId, then g's own
    // firstEventId is below it too and the emission was never safe. So a
    // prefix search is exhaustive — there is no cleverer non-prefix subset
    // that fits under `limit`.)
    let closed = settle(limit);
    if (closed.length === 0) {
      const safe = settle(Infinity);
      let k = safe.length;
      for (let i = 1; i < safe.length; i++) {
        let minFirst = Infinity;
        for (let j = i; j < safe.length; j++) minFirst = Math.min(minFirst, safe[j]!.firstEventId);
        if (safe[i - 1]!.lastEventId < minFirst) {
          k = i;
          break;
        }
      }
      closed = safe.slice(0, k);
    }

    // ⚠️ The emitted set is safe as a WHOLE, and is not safe prefix by
    // prefix: emitted spans may nest (A first 1 last 10, B first 2 last 3
    // both emit, ordered [B, A]), and `cursorFeedTick` advances the cursor
    // per item and stops at the first post failure. If B posts and A's post
    // then fails, A's hits at ids 1-2 sit below the cursor and A re-posts
    // later as a fragment. That is accepted: this feed is at-least-once, and
    // the only rule that IS prefix-safe is the single pass that deadlocks
    // forever on nested closed spans (tried twice, wrong twice). A duplicated
    // fragment after a Discord outage is recoverable; a deadlocked feed is
    // not.

    const out: HitFeedItem[] = [];
    for (const e of closed) {
      const last = e.hits[e.hits.length - 1]!;
      const damages = e.hits.map((h) => h.damage).filter((d): d is number => d !== null);
      // Suppression is checked FIRST and cheaply: a suppressed engagement
      // never renders, so the ~6 name/tag/flag lookups below would be wasted.
      const suppressed = await this.claimedByAKill(e.serverId, e.attackerDayzId, e.victimDayzId, e.startedAt, e.endedAt);
      // A suppressed engagement is never rendered (the render declines it),
      // so the name/tag/flag lookups below would be pure waste.
      const blank = { factionId: null, side: { gamertag: "", tag: null, texture: null } };
      const [attacker, victim] = suppressed
        ? [blank, blank]
        : await Promise.all([
            this.side(e.serverId, e.attackerDayzId, e.endedAt),
            this.side(e.serverId, e.victimDayzId, e.endedAt),
          ]);
      out.push({
        eventId: e.lastEventId, occurredAt: e.endedAt, startedAt: e.startedAt,
        attacker: attacker.side, victim: victim.side, weapon: e.weapon,
        friendlyFire: attacker.factionId !== null && attacker.factionId === victim.factionId,
        suppressed,
        hits: e.hits.map((h) => ({ damage: h.damage, bodyPart: h.bodyPart, weapon: h.weapon, distanceM: h.distanceM })),
        totalDamage: damages.length > 0 ? damages.reduce((a, b) => a + b, 0) : null,
        victimHpAfter: last.victimHp,
      });
    }
    return out;
  }

  /**
   * The name the log knows, and the clan they were in AT THE ENGAGEMENT — the
   * same rule the kill feed follows, so a member who has since left still
   * shows the clan they fought for.
   */
  private async side(serverId: number, dayzId: string, at: Date) {
    const factionId = await membershipAt(this.db, serverId, dayzId, at);
    const [p] = await this.db.select({ gamertag: players.gamertag }).from(players).where(eq(players.dayzId, dayzId));
    const [f] = factionId === null ? [] : await this.db.select({ tag: factions.tag, texture: factions.texture }).from(factions).where(eq(factions.id, factionId));
    return {
      factionId,
      // `players` is a projection and could lag one tick; the id is never shown, so fall back to a word.
      side: { gamertag: p?.gamertag ?? "Unknown", tag: f?.tag ?? null, texture: f?.texture ?? null },
    };
  }

  /**
   * ⚠️ Keyed on (server, attacker, victim) with NO weapon term, though the
   * engagement itself is keyed on weapon. If Steve works Dave over with a
   * KA-74 and switches to a Mosin for the kill, a weapon-keyed check would
   * send the Mosin half to #kill-feed and orphan the KA-74 half here — the
   * same fight, two channels, reading as two unrelated events.
   */
  private async claimedByAKill(serverId: number, attacker: string, victim: string, from: Date, to: Date): Promise<boolean> {
    const until = new Date(to.getTime() + RECENT_HIT_WINDOW_S * 1000);
    const [row] = await this.db.select({ n: sql<number>`count(*)::int` }).from(kills).where(and(
      eq(kills.serverId, serverId), eq(kills.killerDayzId, attacker), eq(kills.victimDayzId, victim),
      gte(kills.occurredAt, from), lte(kills.occurredAt, until),
    ));
    return Number(row?.n ?? 0) > 0;
  }
}
