import type { Database } from "@factions/db";
import { consumerCursors, factions, kills, players, seasons } from "@factions/db";
import { readCursor, writeCursor } from "@factions/event-log";
import { and, asc, desc, eq, gt, gte, isNotNull, isNull, lt, lte, or, sql } from "drizzle-orm";
import { cursorFeedTick, type CursorFeedPoster, type CursorFeedResult, type CursorFeedStore } from "./cursor-feed.js";
import type { FlagImageResolver } from "./feed-embed.js";
import { longRangeFeedEmbed, type LongRangeFeedItem } from "./long-range-feed-embed.js";
import { membershipAt } from "./membership-tick.js";

/** ⚠️ Distinct from every other consumer name. */
export const LONG_RANGE_FEED_CONSUMER = "long-range-feed-poster";
export const DEFAULT_LONG_RANGE_MIN_M = 100;
/** ⚠️ Past this, the rank is omitted: "17th longest this season" is not a highlight. */
export const LONG_RANGE_RANK_CAP = 10;

/** Post long-range PvP kills. Every PvP kill is a candidate; the render declines the short ones. */
export function longRangeFeedTick(
  store: CursorFeedStore<LongRangeFeedItem>,
  post: CursorFeedPoster,
  opts: { siteBaseUrl: string; minM: number; flagImage?: FlagImageResolver; batchSize?: number; onError?: (eventId: number, err: unknown) => void },
): Promise<CursorFeedResult> {
  return cursorFeedTick(store, post, (i) => (i.qualifies ? longRangeFeedEmbed(i, opts.siteBaseUrl, opts.flagImage) : null), {
    batchSize: opts.batchSize,
    onError: opts.onError,
  });
}

/** ⚠️ A kill BY another player — the same rule as every PvP read in the roster. */
const pvp = and(isNotNull(kills.killerDayzId), sql`${kills.killerDayzId} <> ${kills.victimDayzId}`)!;

export class PgLongRangeFeedStore implements CursorFeedStore<LongRangeFeedItem> {
  private readonly minM: number;
  constructor(private readonly db: Database, opts: { minM?: number } = {}) {
    this.minM = opts.minM ?? DEFAULT_LONG_RANGE_MIN_M;
  }

  async seeded(): Promise<boolean> {
    const [row] = await this.db.select({ n: consumerCursors.lastEventId }).from(consumerCursors)
      .where(eq(consumerCursors.consumerName, LONG_RANGE_FEED_CONSUMER));
    return row !== undefined;
  }

  async head(): Promise<number> {
    const [row] = await this.db.select({ n: sql<number>`coalesce(max(${kills.eventId}), 0)::bigint` }).from(kills);
    return Number(row?.n ?? 0);
  }

  cursor(): Promise<number> {
    return readCursor(this.db, LONG_RANGE_FEED_CONSUMER);
  }

  markPosted(eventId: number): Promise<void> {
    return writeCursor(this.db, LONG_RANGE_FEED_CONSUMER, eventId);
  }

  async readAfter(cursor: number, limit: number): Promise<LongRangeFeedItem[]> {
    const rows = await this.db.select({
      eventId: kills.eventId, serverId: kills.serverId, occurredAt: kills.occurredAt,
      killerDayzId: kills.killerDayzId, victimDayzId: kills.victimDayzId,
      weapon: kills.weapon, distanceM: kills.distanceM, friendlyFire: kills.friendlyFire,
    }).from(kills)
      .where(and(gt(kills.eventId, cursor), pvp))
      .orderBy(asc(kills.eventId))
      .limit(limit);

    const out: LongRangeFeedItem[] = [];
    for (const r of rows) {
      // ⚠️ Null is "the log did not say", not zero. Reading it as 0 would be a
      // lie in the one direction this feed cares about.
      const distanceM = r.distanceM === null ? null : Number(r.distanceM);
      const qualifies = distanceM !== null && Number.isFinite(distanceM) && distanceM >= this.minM;

      const base = {
        eventId: Number(r.eventId), occurredAt: r.occurredAt, weapon: r.weapon,
        distanceM, friendlyFire: r.friendlyFire, qualifies,
      };

      if (!qualifies) {
        // Nothing is rendered, so nothing needs resolving — skip four queries.
        out.push({ ...base, killer: blank(), victim: blank(), personalBest: false, seasonRank: null, season: null });
        continue;
      }

      const [killer, victim, records] = await Promise.all([
        this.side(r.serverId, r.killerDayzId!, r.occurredAt),
        this.side(r.serverId, r.victimDayzId, r.occurredAt),
        this.records(r.serverId, r.killerDayzId!, distanceM, r.occurredAt),
      ]);
      out.push({ ...base, killer, victim, ...records });
    }
    return out;
  }

  /**
   * "Longest yet" and the season rank, both counted UP TO AND INCLUDING this
   * kill — so the line reads the same however late the post lands. The same
   * rule the kill feed's tally follows.
   */
  private async records(serverId: number, killer: string, distanceM: number, at: Date) {
    const [season] = await this.db.select({ number: seasons.number, startedAt: seasons.startedAt, endedAt: seasons.endedAt })
      .from(seasons)
      .where(and(eq(seasons.serverId, serverId), lte(seasons.startedAt, at), or(isNull(seasons.endedAt), gt(seasons.endedAt, at))))
      .orderBy(desc(seasons.number)).limit(1);

    const inWindow = season
      ? and(gte(kills.occurredAt, season.startedAt), season.endedAt ? lt(kills.occurredAt, season.endedAt) : sql`true`)!
      : sql`true`;
    const further = sql`${kills.distanceM} > ${String(distanceM)}`;

    const count = (where: ReturnType<typeof and>) =>
      this.db.select({ n: sql<number>`count(*)::int` }).from(kills).where(where).then((r) => Number(r[0]?.n ?? 0));

    const [byKiller, ahead] = await Promise.all([
      count(and(eq(kills.serverId, serverId), pvp, lte(kills.occurredAt, at), eq(kills.killerDayzId, killer), further)),
      count(and(eq(kills.serverId, serverId), pvp, inWindow, lte(kills.occurredAt, at), further)),
    ]);

    const rank = ahead + 1;
    return { personalBest: byKiller === 0, seasonRank: rank <= LONG_RANGE_RANK_CAP ? rank : null, season: season?.number ?? null };
  }

  private async side(serverId: number, dayzId: string, at: Date) {
    const factionId = await membershipAt(this.db, serverId, dayzId, at);
    const [p] = await this.db.select({ gamertag: players.gamertag }).from(players).where(eq(players.dayzId, dayzId));
    const [f] = factionId === null ? [] : await this.db.select({ tag: factions.tag, texture: factions.texture }).from(factions).where(eq(factions.id, factionId));
    return { gamertag: p?.gamertag ?? "Unknown", tag: f?.tag ?? null, texture: f?.texture ?? null };
  }
}

/** A side nothing will render. Only ever reached for a kill the feed declines. */
function blank() {
  return { gamertag: "Unknown", tag: null, texture: null };
}
