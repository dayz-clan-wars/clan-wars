import type { Database } from "@factions/db";
import { consumerCursors, factions, kills, players, seasons } from "@factions/db";
import { readCursor, writeCursor } from "@factions/event-log";
import { and, asc, desc, eq, gt, gte, isNotNull, isNull, lt, lte, or, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { cursorFeedTick, type CursorFeedPoster, type CursorFeedResult, type CursorFeedStore } from "./cursor-feed.js";
import type { FlagImageResolver } from "./feed-embed.js";
import { killFeedEmbed, type KillFeedItem } from "./kill-feed-embed.js";

/** ⚠️ Distinct from every other consumer name. Its value is the `events.id` of the last kill posted. */
export const KILL_FEED_CONSUMER = "kill-feed-poster";
export const KILL_FEED_BATCH_SIZE = 20;

export type KillFeedPoster = CursorFeedPoster;
/** What the tick reads and writes; `PgKillFeedStore` is the real one. */
export type KillFeedStore = CursorFeedStore<KillFeedItem>;
export type KillFeedTickResult = CursorFeedResult;

/**
 * Post new PvP kills to #kill-feed, oldest first. The loop lives in
 * `cursor-feed.ts` — every hazard it guards against is documented there.
 * Every kill this store returns is postable, so the render never declines.
 */
export function killFeedTick(
  store: KillFeedStore,
  post: KillFeedPoster,
  opts: { siteBaseUrl: string; flagImage?: FlagImageResolver; batchSize?: number; onError?: (eventId: number, err: unknown) => void },
): Promise<KillFeedTickResult> {
  return cursorFeedTick(store, post, (k) => killFeedEmbed(k, opts.siteBaseUrl, opts.flagImage), {
    batchSize: opts.batchSize ?? KILL_FEED_BATCH_SIZE,
    onError: opts.onError,
  });
}

/** ⚠️ A kill BY another player — the same rule as every PvP read in the roster. */
const pvp = and(isNotNull(kills.killerDayzId), sql`${kills.killerDayzId} <> ${kills.victimDayzId}`)!;

/**
 * The `kills` table, read for the feed. Names come from `players` (the log's
 * newest gamertag for the id), tags and flags from the faction each side was
 * in AT THE KILL (`kills.*_faction_id`, resolved by the kills projector), so
 * a member who has since left still shows the clan they killed for.
 */
export class PgKillFeedStore implements KillFeedStore {
  constructor(private readonly db: Database) {}

  async seeded(): Promise<boolean> {
    const [row] = await this.db.select({ n: consumerCursors.lastEventId }).from(consumerCursors)
      .where(eq(consumerCursors.consumerName, KILL_FEED_CONSUMER));
    return row !== undefined;
  }

  async head(): Promise<number> {
    const [row] = await this.db.select({ n: sql<number>`coalesce(max(${kills.eventId}), 0)::bigint` }).from(kills);
    return Number(row?.n ?? 0);
  }

  cursor(): Promise<number> {
    return readCursor(this.db, KILL_FEED_CONSUMER);
  }

  markPosted(eventId: number): Promise<void> {
    return writeCursor(this.db, KILL_FEED_CONSUMER, eventId);
  }

  async readAfter(cursor: number, limit: number): Promise<KillFeedItem[]> {
    const killer = alias(players, "killer");
    const victim = alias(players, "victim");
    const killerClan = alias(factions, "killer_clan");
    const victimClan = alias(factions, "victim_clan");
    const rows = await this.db.select({
      eventId: kills.eventId, serverId: kills.serverId, occurredAt: kills.occurredAt,
      killerDayzId: kills.killerDayzId, victimDayzId: kills.victimDayzId,
      killerName: killer.gamertag, victimName: victim.gamertag,
      killerTag: killerClan.tag, killerTexture: killerClan.texture,
      victimTag: victimClan.tag, victimTexture: victimClan.texture,
      weapon: kills.weapon, distanceM: kills.distanceM, friendlyFire: kills.friendlyFire, cause: kills.cause,
    }).from(kills)
      .leftJoin(killer, eq(killer.dayzId, kills.killerDayzId))
      .leftJoin(victim, eq(victim.dayzId, kills.victimDayzId))
      .leftJoin(killerClan, eq(killerClan.id, kills.killerFactionId))
      .leftJoin(victimClan, eq(victimClan.id, kills.victimFactionId))
      .where(and(gt(kills.eventId, cursor), pvp))
      .orderBy(asc(kills.eventId))
      .limit(limit);

    const out: KillFeedItem[] = [];
    for (const r of rows) {
      const tally = await this.tally(r.serverId, r.killerDayzId!, r.victimDayzId, r.occurredAt);
      out.push({
        eventId: Number(r.eventId), occurredAt: r.occurredAt,
        // The log always names a player, but `players` is a projection and
        // could lag one tick; the id is never shown, so fall back to a word.
        killer: { gamertag: r.killerName ?? "Unknown", tag: r.killerTag ?? null, texture: r.killerTexture ?? null },
        victim: { gamertag: r.victimName ?? "Unknown", tag: r.victimTag ?? null, texture: r.victimTexture ?? null },
        weapon: r.weapon, distanceM: r.distanceM === null ? null : Number(r.distanceM),
        friendlyFire: r.friendlyFire, cause: r.cause, tally,
      });
    }
    return out;
  }

  /**
   * The killer's PvP kills and the victim's PvP deaths in the season THIS
   * KILL belongs to — the one whose window contains it — up to and including
   * it, so the line reads the same however late the post lands. A kill
   * before any season (the launch-day backfill) counts all-time; "0 kills
   * this season" under a kill from last week is a wrong sentence, not a
   * small number.
   */
  private async tally(serverId: number, killerDayzId: string, victimDayzId: string, at: Date) {
    const [season] = await this.db.select({ number: seasons.number, startedAt: seasons.startedAt, endedAt: seasons.endedAt })
      .from(seasons)
      .where(and(eq(seasons.serverId, serverId), lte(seasons.startedAt, at), or(isNull(seasons.endedAt), gt(seasons.endedAt, at))))
      .orderBy(desc(seasons.number)).limit(1);
    const inWindow = season
      ? and(gte(kills.occurredAt, season.startedAt), season.endedAt ? lt(kills.occurredAt, season.endedAt) : sql`true`)!
      : sql`true`;
    const upTo = lte(kills.occurredAt, at);
    const count = (where: ReturnType<typeof and>) =>
      this.db.select({ n: sql<number>`count(*)::int` }).from(kills).where(where).then((r) => Number(r[0]?.n ?? 0));
    const [killerKills, victimDeaths] = await Promise.all([
      count(and(eq(kills.serverId, serverId), pvp, inWindow, upTo, eq(kills.killerDayzId, killerDayzId))),
      count(and(eq(kills.serverId, serverId), pvp, inWindow, upTo, eq(kills.victimDayzId, victimDayzId))),
    ]);
    return { killerKills, victimDeaths, season: season?.number ?? null };
  }
}
