import type { Database } from "@factions/db";
import { consumerCursors, factions, kills, players } from "@factions/db";
import { readCursor, writeCursor } from "@factions/event-log";
import { and, asc, desc, eq, gt, isNotNull, lte, sql } from "drizzle-orm";
import { cursorFeedTick, type CursorFeedPoster, type CursorFeedResult, type CursorFeedStore } from "./cursor-feed.js";
import type { FlagImageResolver } from "./feed-embed.js";
import { killstreakFeedEmbed, type KillstreakFeedItem } from "./killstreak-feed-embed.js";
import { membershipAt } from "./membership-tick.js";

/** ⚠️ Distinct from every other consumer name. */
export const KILLSTREAK_FEED_CONSUMER = "killstreak-feed-poster";
/** Post on every Nth kill of a streak. */
export const DEFAULT_KILLSTREAK_EVERY = 3;

/**
 * Post streak milestones to #killstreaks. Every PvP kill is a candidate; the
 * render declines the ones that are not milestones, which is what keeps the
 * cursor moving through ordinary kills.
 */
export function killstreakFeedTick(
  store: CursorFeedStore<KillstreakFeedItem>,
  post: CursorFeedPoster,
  opts: { siteBaseUrl: string; every: number; flagImage?: FlagImageResolver; batchSize?: number; onError?: (eventId: number, err: unknown) => void },
): Promise<CursorFeedResult> {
  const every = opts.every > 0 ? opts.every : DEFAULT_KILLSTREAK_EVERY;
  return cursorFeedTick(
    store, post,
    (i) => (i.streak !== null && i.streak > 0 && i.streak % every === 0 ? killstreakFeedEmbed(i, opts.siteBaseUrl, opts.flagImage) : null),
    { batchSize: opts.batchSize, onError: opts.onError },
  );
}

/** ⚠️ A kill BY another player — the same rule as every PvP read in the roster. */
const pvp = and(isNotNull(kills.killerDayzId), sql`${kills.killerDayzId} <> ${kills.victimDayzId}`)!;
/** A kill that counts toward a streak: PvP, and not a clanmate. */
const streakable = and(pvp, eq(kills.friendlyFire, false))!;

export class PgKillstreakFeedStore implements CursorFeedStore<KillstreakFeedItem> {
  constructor(private readonly db: Database) {}

  async seeded(): Promise<boolean> {
    const [row] = await this.db.select({ n: consumerCursors.lastEventId }).from(consumerCursors)
      .where(eq(consumerCursors.consumerName, KILLSTREAK_FEED_CONSUMER));
    return row !== undefined;
  }

  async head(): Promise<number> {
    const [row] = await this.db.select({ n: sql<number>`coalesce(max(${kills.eventId}), 0)::bigint` }).from(kills);
    return Number(row?.n ?? 0);
  }

  cursor(): Promise<number> {
    return readCursor(this.db, KILLSTREAK_FEED_CONSUMER);
  }

  markPosted(eventId: number): Promise<void> {
    return writeCursor(this.db, KILLSTREAK_FEED_CONSUMER, eventId);
  }

  async readAfter(cursor: number, limit: number): Promise<KillstreakFeedItem[]> {
    const rows = await this.db.select({
      eventId: kills.eventId, serverId: kills.serverId, occurredAt: kills.occurredAt,
      killerDayzId: kills.killerDayzId, friendlyFire: kills.friendlyFire,
    }).from(kills)
      .where(and(gt(kills.eventId, cursor), pvp))
      .orderBy(asc(kills.eventId))
      .limit(limit);

    const out: KillstreakFeedItem[] = [];
    for (const r of rows) {
      const killer = r.killerDayzId!;
      const side = await this.side(r.serverId, killer, r.occurredAt);
      if (r.friendlyFire) {
        // ⚠️ Null, not 0: friendly fire neither advances the streak nor breaks
        // it. Without that rule the cheapest 9-streak on the server is three
        // clanmates standing still.
        out.push({ eventId: Number(r.eventId), occurredAt: r.occurredAt, startedAt: r.occurredAt, killer: side, streak: null, victims: [] });
        continue;
      }
      const run = await this.runUpTo(r.serverId, killer, r.occurredAt);
      out.push({
        eventId: Number(r.eventId), occurredAt: r.occurredAt,
        startedAt: run[0]?.occurredAt ?? r.occurredAt,
        killer: side, streak: run.length,
        victims: run.map((k) => k.gamertag ?? "Unknown"),
      });
    }
    return out;
  }

  /**
   * The killer's streakable kills since the last time ANOTHER PLAYER killed
   * them, up to and including `at`.
   *
   * ⚠️ Derived at post time, never stored. A stored counter would have to be
   * rebuilt in lockstep with `kills` and would drift the first time it was
   * not; this reads the same however late the post lands.
   *
   * ⚠️ Not season-scoped, unlike the kill feed's tally. A tally asks "how well
   * is this season going"; a streak asks "how long since you died". Scoping it
   * would silently reset live streaks at the rollover.
   */
  private async runUpTo(serverId: number, killer: string, at: Date) {
    const [death] = await this.db.select({ at: kills.occurredAt }).from(kills).where(and(
      eq(kills.serverId, serverId), eq(kills.victimDayzId, killer), pvp, lte(kills.occurredAt, at),
    )).orderBy(desc(kills.occurredAt)).limit(1);

    // ⚠️ `gt`, not a raw `sql` template: interpolating a Date directly into
    // `sql` skips drizzle's parameter typing and postgres.js rejects it.
    const since = death ? gt(kills.occurredAt, death.at) : sql`true`;
    return this.db.select({ occurredAt: kills.occurredAt, gamertag: players.gamertag })
      .from(kills)
      .leftJoin(players, eq(players.dayzId, kills.victimDayzId))
      .where(and(eq(kills.serverId, serverId), eq(kills.killerDayzId, killer), streakable, lte(kills.occurredAt, at), since))
      .orderBy(asc(kills.occurredAt));
  }

  /** The name the log knows and the clan they were in at the kill — the kill feed's rule. */
  private async side(serverId: number, dayzId: string, at: Date) {
    const factionId = await membershipAt(this.db, serverId, dayzId, at);
    const [p] = await this.db.select({ gamertag: players.gamertag }).from(players).where(eq(players.dayzId, dayzId));
    const [f] = factionId === null ? [] : await this.db.select({ tag: factions.tag, texture: factions.texture }).from(factions).where(eq(factions.id, factionId));
    return { gamertag: p?.gamertag ?? "Unknown", tag: f?.tag ?? null, texture: f?.texture ?? null };
  }
}
