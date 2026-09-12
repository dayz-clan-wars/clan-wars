import { describe, it, expect, vi } from "vitest";
import type { APIEmbed } from "discord.js";
import { cursorFeedTick, type CursorFeedStore } from "../src/cursor-feed.js";

type Item = { eventId: number; name: string; skip?: boolean };

/** An in-memory store: `cursor` null means never seeded. */
function fakeStore(items: Item[], cursor: number | null): CursorFeedStore<Item> & { at: () => number | null } {
  let c = cursor;
  return {
    at: () => c,
    seeded: async () => c !== null,
    head: async () => Math.max(0, ...items.map((i) => i.eventId)),
    cursor: async () => c ?? 0,
    readAfter: async (after, limit) =>
      items.filter((i) => i.eventId > after).sort((a, b) => a.eventId - b.eventId).slice(0, limit),
    markPosted: async (id) => { c = id; },
  };
}

const render = (i: Item): APIEmbed | null => (i.skip ? null : { title: i.name });

describe("cursorFeedTick", () => {
  it("⚠️ the first run seeds the cursor at the head and posts nothing — history never floods the channel", async () => {
    const store = fakeStore([{ eventId: 10, name: "a" }, { eventId: 30, name: "b" }], null);
    const post = vi.fn(async () => {});
    const r = await cursorFeedTick(store, post, render);
    expect(r).toEqual({ posted: 0, blockedAt: null, seeded: true });
    expect(post).not.toHaveBeenCalled();
    expect(store.at()).toBe(30);
  });

  it("posts every item after the cursor, oldest first, advancing as it goes", async () => {
    const store = fakeStore([{ eventId: 10, name: "a" }, { eventId: 20, name: "b" }, { eventId: 30, name: "c" }], 10);
    const post = vi.fn<(e: APIEmbed) => Promise<void>>(async () => {});
    const r = await cursorFeedTick(store, post, render);
    expect(r).toEqual({ posted: 2, blockedAt: null, seeded: false });
    expect(post.mock.calls.map(([e]) => e.title)).toEqual(["b", "c"]);
    expect(store.at()).toBe(30);
  });

  it("a null render advances the cursor without posting — the item is decided, not pending", async () => {
    const store = fakeStore([{ eventId: 10, name: "a", skip: true }, { eventId: 20, name: "b" }], 0);
    const post = vi.fn<(e: APIEmbed) => Promise<void>>(async () => {});
    const r = await cursorFeedTick(store, post, render);
    expect(r.posted).toBe(1);
    expect(post.mock.calls.map(([e]) => e.title)).toEqual(["b"]);
    expect(store.at()).toBe(20);
  });

  it("stops at the first failure and leaves the cursor on the last success", async () => {
    const store = fakeStore([{ eventId: 10, name: "a" }, { eventId: 20, name: "b" }, { eventId: 30, name: "c" }], 0);
    const post = vi.fn(async (e: APIEmbed) => { if (e.title === "b") throw new Error("discord is down"); });
    const onError = vi.fn();
    const r = await cursorFeedTick(store, post, render, { onError });
    expect(r).toEqual({ posted: 1, blockedAt: 20, seeded: false });
    expect(store.at()).toBe(10);
    expect(onError).toHaveBeenCalledWith(20, expect.any(Error));
  });

  it("honours the batch size", async () => {
    const store = fakeStore([{ eventId: 1, name: "a" }, { eventId: 2, name: "b" }, { eventId: 3, name: "c" }], 0);
    const r = await cursorFeedTick(store, async () => {}, render, { batchSize: 2 });
    expect(r.posted).toBe(2);
    expect(store.at()).toBe(2);
  });
});
