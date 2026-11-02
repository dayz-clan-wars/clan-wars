import type { Scoreboard } from "@factions/roster";
import { scoreboardKey, type ScoreboardPost } from "./scoreboard-post.js";

export type ScoreboardStore = { read(): Promise<Scoreboard> };

/** Everything the tick does to the #scoreboard channel. Every method throws on an unreachable path. */
export interface ScoreboardChannel {
  /** Our standing post's id, found by its heading link, or null when there is none. */
  findMine(): Promise<string | null>;
  post(p: ScoreboardPost): Promise<string>;
  edit(messageId: string, p: ScoreboardPost): Promise<void>;
}

/**
 * Carried between ticks: which post the last successful render went to, and
 * what it showed.
 */
export type ScoreboardState = { messageId: string | null; key: string | null };

export type ScoreboardTickResult = { posted: boolean; edited: boolean; errors: number };

/**
 * Keep the #scoreboard channel's one standing post current, edited in place.
 *
 * ⚠️ A failed standings read writes NOTHING. Rendering an empty table from a
 * failed query would wipe every card and fill them again next pass.
 *
 * ⚠️ There is no stored message id. The post is found in the channel by its
 * heading link EVERY pass, not just at start: a restart adopts the post
 * already there instead of sending a second one, and a post someone deleted
 * comes back on the next pass even when no score has moved. One message read
 * per pass, on the leaderboards' five-minute clock, is all that costs.
 *
 * ⚠️ The key is written only after a post or edit succeeds, so a failed one
 * is retried next pass rather than believed shown.
 */
export async function scoreboardTick(
  store: ScoreboardStore,
  channel: ScoreboardChannel,
  state: ScoreboardState,
  render: (board: Scoreboard) => ScoreboardPost,
  onError?: (what: string, err: unknown) => void,
): Promise<ScoreboardTickResult> {
  const out: ScoreboardTickResult = { posted: false, edited: false, errors: 0 };

  let board: Scoreboard;
  try {
    board = await store.read();
  } catch (err) {
    out.errors++;
    onError?.("scoreboard-read", err);
    return out;
  }

  let found: string | null;
  try {
    found = await channel.findMine();
  } catch (err) {
    out.errors++;
    onError?.("channel-read", err);
    return out;
  }

  const key = scoreboardKey(board);
  if (found === null) {
    try {
      state.messageId = await channel.post(render(board));
      state.key = key;
      out.posted = true;
    } catch (err) {
      out.errors++;
      onError?.("post", err);
    }
    return out;
  }

  // A post we have not shown a render on (first pass, or one adopted after a
  // restart) is redrawn once, whatever it currently says.
  if (found !== state.messageId) state.key = null;
  state.messageId = found;
  if (state.key === key) return out;
  try {
    await channel.edit(found, render(board));
    state.key = key;
    out.edited = true;
  } catch (err) {
    out.errors++;
    onError?.("edit", err);
  }
  return out;
}
