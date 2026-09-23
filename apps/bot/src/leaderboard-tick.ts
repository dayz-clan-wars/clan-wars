import type { APIEmbed } from "discord.js";
import type { Database } from "@factions/db";
import { BOARD_KINDS, type BoardKind, type Boards } from "@factions/roster";
import { BOARD_TOP } from "@factions/copy";
import { playerBoardsDb } from "@factions/roster/internal";
import { leaderboardEmbed, leaderboardKey } from "./leaderboard-embed.js";

export type LeaderboardStore = { read(): Promise<Boards> };

/** Everything the tick does to the leaderboards channel. Every method throws on an unreachable path. */
export interface LeaderboardChannel {
  /** Our own standing messages, by the board each one's embed URL names. */
  findMine(): Promise<Map<BoardKind, string>>;
  /** Delete every message of ours in the channel. Returns how many went. */
  purgeMine(): Promise<number>;
  /** Send a board's message and return its id. */
  post(kind: BoardKind, embed: APIEmbed): Promise<string>;
  edit(messageId: string, embed: APIEmbed): Promise<void>;
}

/**
 * Carried between ticks. `messageIds` is null until the channel has been read
 * once (at start, and again after any rebuild); `keys` holds the last
 * SUCCESSFULLY shown render of each board.
 */
export type LeaderboardState = {
  messageIds: Map<BoardKind, string> | null;
  keys: Map<BoardKind, string>;
};

export type LeaderboardTickResult = {
  posted: number;
  edited: number;
  rebuilt: boolean;
  errors: number;
};

/**
 * Keep the leaderboards channel's ten standing messages current: one per
 * board, in `BOARD_KINDS` order (the site's own display order), edited in
 * place rather than reposted.
 *
 * ⚠️ A failed board read writes NOTHING. Rendering "no rows" from a failed
 * query would blank all ten messages at once and then fill them again on the
 * next pass.
 *
 * ⚠️ There is no stored message id. The ten are rediscovered from the channel
 * itself by the board link in each embed, so a restart adopts the messages
 * already there instead of posting ten more. If any of the ten is missing,
 * the channel is REBUILT — purged and re-posted in order — because sending
 * just the missing one would put it at the bottom, out of the site's order,
 * and nothing could ever put it back.
 *
 * ⚠️ A board's key is written only AFTER its edit succeeds, so a failed edit
 * leaves the key stale and the next pass tries that board again rather than
 * believing the message is current.
 */
export async function leaderboardTick(
  store: LeaderboardStore,
  channel: LeaderboardChannel,
  state: LeaderboardState,
  siteBaseUrl: string,
  onError?: (what: string, err: unknown) => void,
): Promise<LeaderboardTickResult> {
  const out: LeaderboardTickResult = { posted: 0, edited: 0, rebuilt: false, errors: 0 };

  let boards: Boards;
  try {
    boards = await store.read();
  } catch (err) {
    out.errors++;
    onError?.("boards-read", err);
    return out;
  }

  if (state.messageIds === null) {
    try {
      const found = await channel.findMine();
      state.messageIds = BOARD_KINDS.every((k) => found.has(k)) ? found : null;
    } catch (err) {
      out.errors++;
      onError?.("channel-read", err);
      return out;
    }
  }

  // Rebuild: either the channel had none of ours, or it was missing some. Both
  // end the same way — ten fresh messages in order — because order is only
  // ever established at post time.
  if (state.messageIds === null) {
    try {
      await channel.purgeMine();
      const ids = new Map<BoardKind, string>();
      const keys = new Map<BoardKind, string>();
      for (const kind of BOARD_KINDS) {
        ids.set(kind, await channel.post(kind, leaderboardEmbed(kind, boards, siteBaseUrl)));
        keys.set(kind, leaderboardKey(kind, boards));
        out.posted++;
      }
      state.messageIds = ids;
      state.keys = keys;
      out.rebuilt = true;
    } catch (err) {
      // A part-built channel: drop what we think we know so the next pass
      // rediscovers and rebuilds from scratch rather than editing ids that
      // may not line up with what is actually there.
      state.messageIds = null;
      state.keys = new Map();
      out.errors++;
      onError?.("rebuild", err);
    }
    return out;
  }

  for (const kind of BOARD_KINDS) {
    const key = leaderboardKey(kind, boards);
    if (state.keys.get(kind) === key) continue;
    const messageId = state.messageIds.get(kind)!;
    try {
      await channel.edit(messageId, leaderboardEmbed(kind, boards, siteBaseUrl));
      state.keys.set(kind, key);
      out.edited++;
    } catch (err) {
      out.errors++;
      onError?.(kind, err);
    }
  }
  return out;
}

/**
 * The ten boards at the same depth and scope the site's `/players` panels
 * use — `BOARD_TOP` rows of the current season — so the channel and the page
 * cannot show different numbers.
 */
export class PgLeaderboardStore implements LeaderboardStore {
  constructor(private readonly db: Database, private readonly now: () => Date = () => new Date()) {}

  read(): Promise<Boards> {
    return playerBoardsDb(this.db, { kind: "current" }, BOARD_TOP, this.now());
  }
}
