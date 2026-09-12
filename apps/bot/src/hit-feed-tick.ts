import type { Database } from "@factions/db";
import { consumerCursors, events, factions, kills, players } from "@factions/db";
import { readCursor, writeCursor } from "@factions/event-log";
import { DEFAULT_HIT_BURST_WINDOW_S, RECENT_HIT_WINDOW_S, groupHitBursts, type HitInput } from "@factions/domain";
import { and, asc, eq, gt, gte, lte, sql } from "drizzle-orm";
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
   * ⚠️ "Now" for the closing test, and it is NOT the wall clock.
   *
   * It is the `occurred_at` of the event the KILLS projector has reached. That
   * is by construction at or behind the ingest frontier, so it guards two
   * hazards with one value: batched ingest cannot look like quiet, and a
   * wedged kills projector cannot let a fatal engagement slip into this feed
   * before the `kills` row that would suppress it exists.
   *
   * Null — kills has never run — means nothing closes. Correct: with no
   * projected kills there is no way to tell a fight from a killing.
   */
  private async frontier(): Promise<Date | null> {
    const killsCursor = await readCursor(this.db, KILLS_CONSUMER);
    if (killsCursor === 0) return null;
    const [row] = await this.db.select({ at: events.occurredAt }).from(events).where(eq(events.id, killsCursor));
    return row?.at ?? null;
  }

  async readAfter(cursor: number, limit: number): Promise<HitFeedItem[]> {
    const frontier = await this.frontier();
    if (frontier === null) return [];

    // ⚠️ Read more rows than engagements wanted: one engagement is many hits,
    // and a burst cut in half by the row limit would be posted twice.
    const rows = await this.db.select({ id: events.id, serverId: events.serverId, occurredAt: events.occurredAt, payload: events.payload })
      .from(events)
      .where(and(gt(events.id, cursor), eq(events.type, "player.hit"), lte(events.occurredAt, frontier)))
      .orderBy(asc(events.id))
      .limit(limit * 50);

    if (rows.length === 0) return [];

    // ⚠️ When the row limit truncated the read, the effective frontier is the
    // last row we actually saw: everything past it is unknown, and a burst
    // judged quiet against a frontier we did not read up to is a burst that
    // may still be running.
    const truncated = rows.length === limit * 50;
    const effective = truncated ? rows[rows.length - 1]!.occurredAt : frontier;

    const inputs: HitInput[] = rows.map((r) => {
      const p = r.payload as Record<string, unknown>;
      const type = p.attackerType;
      return {
        eventId: Number(r.id), occurredAt: r.occurredAt,
        attackerType: type === "player" || type === "infected" ? type : "environment",
        attackerDayzId: str(p.attackerDayzId), victimDayzId: str(p.victimDayzId) ?? "",
        weapon: str(p.weapon), damage: num(p.damage), bodyPart: str(p.bodyPart),
        distanceM: num(p.distanceM), victimHp: num(p.victimHp),
      };
    });

    const serverId = rows[0]!.serverId;
    const closed = groupHitBursts(inputs, { frontier: effective, windowS: this.windowS })
      .filter((e) => e.closed)
      .slice(0, limit);

    const out: HitFeedItem[] = [];
    for (const e of closed) {
      const last = e.hits[e.hits.length - 1]!;
      const damages = e.hits.map((h) => h.damage).filter((d): d is number => d !== null);
      const [attacker, victim, suppressed] = await Promise.all([
        this.side(serverId, e.attackerDayzId, e.endedAt),
        this.side(serverId, e.victimDayzId, e.endedAt),
        this.claimedByAKill(serverId, e.attackerDayzId, e.victimDayzId, e.startedAt, e.endedAt),
      ]);
      out.push({
        eventId: e.lastEventId, occurredAt: e.endedAt, startedAt: e.startedAt,
        attacker: attacker.side, victim: victim.side, weapon: e.weapon, distanceM: last.distanceM,
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
   * ⚠️ Keyed on (attacker, victim) with NO weapon term, though the engagement
   * itself is keyed on weapon. If Steve works Dave over with a KA-74 and
   * switches to a Mosin for the kill, a weapon-keyed check would send the
   * Mosin half to #kill-feed and orphan the KA-74 half here — the same fight,
   * two channels, reading as two unrelated events.
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
