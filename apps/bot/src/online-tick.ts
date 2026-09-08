import type { APIEmbed } from "discord.js";
import type { Database } from "@factions/db";
import { factions, membershipHistory, playerSessions, players } from "@factions/db";
import { and, asc, eq, isNull } from "drizzle-orm";
import { onlineEmbed, onlineKey, type OnlinePlayer } from "./online-embed.js";

export type OnlineStore = { read(): Promise<OnlinePlayer[]> };
/** The single message: `show` creates it if it is missing and edits it otherwise. */
export type OnlineBoard = { show(embed: APIEmbed): Promise<void> };
/** Carried between ticks so an unchanged roster edits nothing. */
export type OnlineState = { lastKey: string | null };

export type OnlineTickResult = { players: number; edited: boolean };

/**
 * Keep #players-online's one message current. Reads the open sessions and
 * re-renders only when the set of players (or their tags, or their connect
 * times) changed since the last successful show — a restart shows once,
 * unconditionally, so the message never lags a redeploy.
 *
 * ⚠️ `lastKey` is written only AFTER the show succeeds. A failed edit leaves
 * it stale, so the next tick tries again rather than believing the message.
 */
export async function onlineTick(store: OnlineStore, board: OnlineBoard, state: OnlineState, now: Date): Promise<OnlineTickResult> {
  const online = await store.read();
  const key = onlineKey(online);
  if (key === state.lastKey) return { players: online.length, edited: false };
  await board.show(onlineEmbed(online, now));
  state.lastKey = key;
  return { players: online.length, edited: true };
}

/**
 * Open sessions, with the log's name for each id and the clan the player is
 * in NOW (the open `membership_history` span) — a board is about the present,
 * unlike a kill, which is about its instant.
 */
export class PgOnlineStore implements OnlineStore {
  constructor(private readonly db: Database) {}

  async read(): Promise<OnlinePlayer[]> {
    const rows = await this.db.select({
      dayzId: playerSessions.dayzId, gamertag: players.gamertag, connectedAt: playerSessions.connectedAt, tag: factions.tag,
    }).from(playerSessions)
      .leftJoin(players, eq(players.dayzId, playerSessions.dayzId))
      .leftJoin(membershipHistory, and(
        eq(membershipHistory.serverId, playerSessions.serverId), eq(membershipHistory.dayzId, playerSessions.dayzId), isNull(membershipHistory.leftAt),
      ))
      .leftJoin(factions, eq(factions.id, membershipHistory.factionId))
      .where(isNull(playerSessions.disconnectedAt))
      .orderBy(asc(playerSessions.connectedAt));
    return rows.map((r) => ({ dayzId: r.dayzId, gamertag: r.gamertag ?? "Unknown", tag: r.tag ?? null, connectedAt: r.connectedAt }));
  }
}
