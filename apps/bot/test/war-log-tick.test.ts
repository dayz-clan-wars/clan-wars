import { describe, it, expect, vi } from "vitest";
import { warLogTick } from "../src/war-log-tick.js";
import type { WarLogStore, QueuedWarLog } from "@factions/roster/internal";

const now = new Date("2026-09-06T12:00:00Z");
const siteBaseUrl = "https://dayzclanwars.com";

const row = (id: number): QueuedWarLog => ({
  id, kind: "defense",
  occurredAt: now,
  payload: { victimClan: `F${id}`, victimTag: `T${id}`, gamertag: "X", durationSeconds: 60 },
});

/** An in-memory WarLogStore whose queue behaves like the real one. */
function fakeStore(rows: QueuedWarLog[]): WarLogStore & { posted: number[] } {
  const posted: number[] = [];
  return {
    posted,
    readUnposted: async (limit) =>
      rows.filter((r) => !posted.includes(r.id)).sort((a, b) => a.id - b.id).slice(0, limit),
    markPosted: async (id) => { posted.push(id); },
  };
}

describe("warLogTick", () => {
  it("posts every queued row in order and marks each", async () => {
    const store = fakeStore([row(1), row(2), row(3)]);
    const post = vi.fn<(content: string) => Promise<void>>().mockResolvedValue(undefined);

    const r = await warLogTick(store, post, { now, siteBaseUrl });

    expect(r.posted).toBe(3);
    expect(r.blockedAt).toBeNull();
    expect(store.posted).toEqual([1, 2, 3]);
  });

  it("stops at the first failure instead of skipping ahead", async () => {
    const store = fakeStore([row(1), row(2), row(3)]);
    const post = vi.fn(async (content: string) => {
      if (content.includes("F2")) throw new Error("discord is down");
    });

    const r = await warLogTick(store, post, { now, siteBaseUrl });

    expect(r.posted).toBe(1);
    expect(r.blockedAt).toBe(2);
    expect(store.posted).toEqual([1]);
    expect(post).toHaveBeenCalledTimes(2);
  });

  it("posts, then marks — a mark failure blocks the row too", async () => {
    const store = fakeStore([row(1), row(2)]);
    const post = vi.fn(async () => {});
    store.markPosted = async () => { throw new Error("db down"); };
    const onError = vi.fn();

    const r = await warLogTick(store, post, { now, siteBaseUrl, onError });

    expect(r.posted).toBe(0);
    expect(r.blockedAt).toBe(1);
    expect(onError).toHaveBeenCalledTimes(1);
    expect(post).toHaveBeenCalledTimes(1);
  });

  it("does nothing, quietly, on an empty queue", async () => {
    const post = vi.fn();
    const r = await warLogTick(fakeStore([]), post, { now, siteBaseUrl });
    expect(r).toEqual({ posted: 0, blockedAt: null });
    expect(post).not.toHaveBeenCalled();
  });

  it("honours batchSize", async () => {
    const store = fakeStore([row(1), row(2), row(3)]);
    const r = await warLogTick(store, async () => {}, { now, siteBaseUrl, batchSize: 2 });
    expect(r.posted).toBe(2);
  });
});
