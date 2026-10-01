import type { Database } from "@factions/db";
import { banAnnouncements, clanNotices, factionEvents, factions, feedEntries, membershipHistory, playerSessions, players, warLogEvents } from "@factions/db";
import {
  LIVE_FEED_KIND, LIVE_PAGE_SIZE,
  type LiveFeed, type LiveEntryKind, type LivePayload, type FactionEventKind, type WarLogKind, type BanAnnouncementKind, type BanReason,
} from "@factions/domain";
import { and, asc, desc, eq, gt, isNull, lt, sql, type SQL } from "drizzle-orm";
import type { AnyPgColumn } from "drizzle-orm/pg-core";
import { activeServerId } from "./server";

export type LiveRow =
  | { feed: "kills" | "hits" | "streaks" | "long-range"; id: number; occurredAt: Date; payload: LivePayload[LiveEntryKind] }
  | { feed: "clans"; id: number; occurredAt: Date; kind: FactionEventKind; payload: { name: string; tag: string; texture: string; actor?: string; previousName?: string; disbandAt?: string } }
  | { feed: "war-log"; id: number; occurredAt: Date; kind: WarLogKind; payload: Record<string, unknown> }
  | { feed: "achievements"; id: number; occurredAt: Date; payload: { key: string; name: string; description: string; ownerKind: "player" | "clan"; ownerName: string | null; gamertag: string | null; clanTag: string | null } }
  | { feed: "bans"; id: number; occurredAt: Date; kind: BanAnnouncementKind; payload: { gamertag: string; reason: BanReason; expiresAt: string | null } };

export type LiveQuery = { before?: number; after?: number; limit?: number };
export type OnlinePlayerRow = { gamertag: string; tag: string | null; connectedAt: Date };

const clamp = (n: number | undefined) => Math.min(LIVE_PAGE_SIZE, Math.max(1, Math.trunc(n ?? LIVE_PAGE_SIZE) || 1));

/** `id < before` or `id > after`; after wins. Both are integers the caller has already validated. */
function window(id: AnyPgColumn, q: LiveQuery): SQL | undefined {
  if (q.after !== undefined) return gt(id, q.after);
  if (q.before !== undefined) return lt(id, q.before);
  return undefined;
}

// ⚠️ An unlinked owner's `ownerName` is their Discord id. The site must never print it.
const DISCORD_ID = /^\d+$/u;

export async function liveFeedDb(db: Database, feed: Exclude<LiveFeed, "online">, q: LiveQuery = {}): Promise<LiveRow[]> {
  const serverId = await activeServerId(db);
  const limit = clamp(q.limit);
  switch (feed) {
    case "kills": case "hits": case "streaks": case "long-range": {
      const rows = await db.select({ id: feedEntries.id, occurredAt: feedEntries.occurredAt, payload: feedEntries.payload }).from(feedEntries)
        .where(and(eq(feedEntries.serverId, serverId), eq(feedEntries.kind, LIVE_FEED_KIND[feed]), window(feedEntries.id, q)))
        .orderBy(desc(feedEntries.id)).limit(limit);
      return rows.map((r) => ({ feed, id: r.id, occurredAt: r.occurredAt, payload: r.payload as never }));
    }
    case "clans": {
      const rows = await db.select({ id: factionEvents.id, occurredAt: factionEvents.occurredAt, kind: factionEvents.kind, payload: factionEvents.payload }).from(factionEvents)
        .where(and(eq(factionEvents.serverId, serverId), window(factionEvents.id, q)))
        .orderBy(desc(factionEvents.id)).limit(limit);
      return rows.map((r) => ({ feed, ...r, payload: r.payload as never }));
    }
    case "war-log": {
      const rows = await db.select({ id: warLogEvents.id, occurredAt: warLogEvents.occurredAt, kind: warLogEvents.kind, payload: warLogEvents.payload }).from(warLogEvents)
        .where(and(eq(warLogEvents.serverId, serverId), window(warLogEvents.id, q)))
        .orderBy(desc(warLogEvents.id)).limit(limit);
      return rows.map((r) => ({ feed, ...r, payload: r.payload as Record<string, unknown> }));
    }
    case "achievements": {
      const rows = await db.select({ id: clanNotices.id, occurredAt: clanNotices.occurredAt, payload: clanNotices.payload }).from(clanNotices)
        .where(and(
          eq(clanNotices.serverId, serverId), eq(clanNotices.kind, "achievement"), eq(clanNotices.target, "channel"),
          isNull(clanNotices.factionId), sql`${clanNotices.payload}->>'public' = 'true'`, window(clanNotices.id, q),
        ))
        .orderBy(desc(clanNotices.id)).limit(limit);
      return rows.map((r) => {
        const p = r.payload as Record<string, unknown>;
        const str = (v: unknown) => (typeof v === "string" && v !== "" ? v : null);
        const ownerName = str(p.ownerName);
        return {
          feed, id: r.id, occurredAt: r.occurredAt,
          payload: {
            key: String(p.key), name: String(p.name), description: String(p.description),
            ownerKind: p.ownerKind === "clan" ? "clan" : "player",
            ownerName: ownerName !== null && DISCORD_ID.test(ownerName) ? null : ownerName,
            gamertag: str(p.gamertag), clanTag: str(p.clanTag),
          },
        };
      });
    }
    case "bans": {
      const rows = await db.select({ id: banAnnouncements.id, occurredAt: banAnnouncements.occurredAt, kind: banAnnouncements.kind, payload: banAnnouncements.payload }).from(banAnnouncements)
        .where(and(eq(banAnnouncements.serverId, serverId), window(banAnnouncements.id, q)))
        .orderBy(desc(banAnnouncements.id)).limit(limit);
      // ⚠️ Pick the three keys by name: the payload is a public page, so nothing else may ride along.
      return rows.map((r) => {
        const p = r.payload as Record<string, unknown>;
        return { feed, id: r.id, occurredAt: r.occurredAt, kind: r.kind, payload: { gamertag: String(p.gamertag), reason: p.reason as BanReason, expiresAt: typeof p.expiresAt === "string" ? p.expiresAt : null } };
      });
    }
  }
}

/** The bot's #players-online board (apps/bot/src/online-tick.ts PgOnlineStore), minus the DayZ id. */
export async function onlineNowDb(db: Database): Promise<OnlinePlayerRow[]> {
  const serverId = await activeServerId(db);
  const rows = await db.select({ gamertag: players.gamertag, connectedAt: playerSessions.connectedAt, tag: factions.tag }).from(playerSessions)
    .leftJoin(players, eq(players.dayzId, playerSessions.dayzId))
    .leftJoin(membershipHistory, and(eq(membershipHistory.serverId, playerSessions.serverId), eq(membershipHistory.dayzId, playerSessions.dayzId), isNull(membershipHistory.leftAt)))
    .leftJoin(factions, eq(factions.id, membershipHistory.factionId))
    .where(and(eq(playerSessions.serverId, serverId), isNull(playerSessions.disconnectedAt)))
    .orderBy(asc(playerSessions.connectedAt));
  return rows.map((r) => ({ gamertag: r.gamertag ?? "Unknown", tag: r.tag ?? null, connectedAt: r.connectedAt }));
}
