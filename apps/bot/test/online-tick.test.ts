import { describe, it, expect, vi } from "vitest";
import { onlineTick, type OnlineBoard, type OnlineState } from "../src/online-tick.js";
import type { OnlinePlayer } from "../src/online-embed.js";

const now = new Date("2026-09-08T18:00:00Z");
const p = (gamertag: string): OnlinePlayer => ({ dayzId: gamertag.padEnd(40, "0"), gamertag, tag: null, connectedAt: now });

describe("onlineTick", () => {
  it("shows on the first tick, then only when the roster changes", async () => {
    let online = [p("A")];
    const store = { read: async () => online };
    const board: OnlineBoard = { show: vi.fn(async () => {}) };
    const state: OnlineState = { lastKey: null };

    expect(await onlineTick(store, board, state, now)).toEqual({ players: 1, edited: true });
    expect(await onlineTick(store, board, state, now)).toEqual({ players: 1, edited: false });
    online = [p("A"), p("B")];
    expect(await onlineTick(store, board, state, now)).toEqual({ players: 2, edited: true });
    online = [];
    expect(await onlineTick(store, board, state, now)).toEqual({ players: 0, edited: true });
    expect(await onlineTick(store, board, state, now)).toEqual({ players: 0, edited: false });
    expect(board.show).toHaveBeenCalledTimes(3);
  });

  it("⚠️ a failed show is retried next tick — the key is recorded only after success", async () => {
    const store = { read: async () => [p("A")] };
    const show = vi.fn<(e: unknown) => Promise<void>>().mockRejectedValueOnce(new Error("discord is down")).mockResolvedValue(undefined);
    const state: OnlineState = { lastKey: null };
    await expect(onlineTick(store, { show }, state, now)).rejects.toThrow("discord is down");
    expect(state.lastKey).toBeNull();
    expect(await onlineTick(store, { show }, state, now)).toEqual({ players: 1, edited: true });
    expect(state.lastKey).not.toBeNull();
  });
});
