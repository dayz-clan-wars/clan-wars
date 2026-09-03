import { describe, it, expect, vi } from "vitest";
import type { APIEmbed } from "discord.js";
import { feedTick } from "../src/feed-tick.js";
import type { FeedStore, QueuedFactionEvent } from "../src/feed-store.js";

const now = new Date("2026-09-03T12:00:00Z");

const row = (id: number, kind: QueuedFactionEvent["kind"] = "founded"): QueuedFactionEvent => ({
  id, kind, occurredAt: now,
  payload: { name: `F${id}`, tag: `T${id}`, texture: "Flag_Wolf" },
});

/** An in-memory FeedStore whose queue behaves like the real one. */
function fakeStore(rows: QueuedFactionEvent[]): FeedStore & { posted: number[] } {
  const posted: number[] = [];
  return {
    posted,
    readUnposted: async (limit) =>
      rows.filter((r) => !posted.includes(r.id)).sort((a, b) => a.id - b.id).slice(0, limit),
    markPosted: async (id) => { posted.push(id); },
  };
}

describe("feedTick", () => {
  it("posts every queued row and marks each", async () => {
    const store = fakeStore([row(1), row(2), row(3)]);
    const post = vi.fn<(embed: APIEmbed) => Promise<void>>().mockResolvedValue(undefined);

    const r = await feedTick(store, post, { now });

    expect(r.posted).toBe(3);
    expect(r.blockedAt).toBeNull();
    expect(store.posted).toEqual([1, 2, 3]);
  });

  it("⚠️ posts in ascending id order", async () => {
    // The channel is read top-down. Out of order, 'disbanded' can appear
    // above the 'dormant' that preceded it, and the feed stops being a
    // record of anything.
    const store = fakeStore([row(3), row(1), row(2)]);
    const seen: string[] = [];
    await feedTick(store, async (e) => { seen.push(e.title!); }, { now });
    expect(seen).toEqual(["F1 [T1]", "F2 [T2]", "F3 [T3]"]);
  });

  it("⚠️ stops at the first failure instead of skipping ahead", async () => {
    // Skipping would let a retried older event land below newer ones.
    const store = fakeStore([row(1), row(2), row(3)]);
    const post = vi.fn(async (e: APIEmbed) => {
      if (e.title === "F2 [T2]") throw new Error("discord is down");
    });

    const r = await feedTick(store, post, { now });

    expect(r.posted).toBe(1);
    expect(r.blockedAt).toBe(2);
    expect(store.posted).toEqual([1]);
    expect(post).toHaveBeenCalledTimes(2);
  });

  it("⚠️ leaves a failed row queued so the next tick retries it", async () => {
    // The transition is real; the announcement should land the moment it can.
    const store = fakeStore([row(1), row(2)]);
    let down = true;
    const post = async () => { if (down) throw new Error("down"); };

    expect((await feedTick(store, post, { now })).posted).toBe(0);
    expect(store.posted).toEqual([]);

    down = false;
    expect((await feedTick(store, post, { now })).posted).toBe(2);
    expect(store.posted).toEqual([1, 2]);
  });

  it("reports each failing row once through onError", async () => {
    const store = fakeStore([row(1)]);
    const onError = vi.fn();
    await feedTick(store, async () => { throw new Error("nope"); }, { now, onError });
    expect(onError).toHaveBeenCalledTimes(1);
    expect(onError.mock.calls[0]![0]).toBe(1);
  });

  it("does nothing, quietly, on an empty queue", async () => {
    const post = vi.fn();
    const r = await feedTick(fakeStore([]), post, { now });
    expect(r).toEqual({ posted: 0, blockedAt: null });
    expect(post).not.toHaveBeenCalled();
  });

  it("honours batchSize so one tick cannot hold the runner forever", async () => {
    const store = fakeStore([row(1), row(2), row(3)]);
    const r = await feedTick(store, async () => {}, { now, batchSize: 2 });
    expect(r.posted).toBe(2);
  });
});
