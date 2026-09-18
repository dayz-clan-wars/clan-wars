import { describe, it, expect, vi } from "vitest";
import type { APIEmbed } from "discord.js";
import { releaseTick, type QueuedRelease, type ReleaseStore } from "../src/release-tick.js";

const now = new Date("2026-09-17T12:00:00Z");

const row = (id: number, over: Partial<QueuedRelease> = {}): QueuedRelease => ({
  id,
  version: `1.${id}.0`,
  title: `release ${id}`,
  body: `### Added\n\n- Thing ${id}.`,
  releasedAt: new Date("2026-09-17T00:00:00Z"),
  ...over,
});

function fakeStore(rows: QueuedRelease[]): ReleaseStore & { posted: number[] } {
  const posted: number[] = [];
  return {
    posted,
    readOldestUnposted: async () =>
      rows.filter((r) => !posted.includes(r.id)).sort((a, b) => a.id - b.id)[0] ?? null,
    markPosted: async (id) => { posted.push(id); },
  };
}

describe("releaseTick", () => {
  it("posts the oldest unposted release and marks it", async () => {
    const store = fakeStore([row(1), row(2)]);
    const post = vi.fn<(e: APIEmbed) => Promise<void>>().mockResolvedValue(undefined);

    const r = await releaseTick(store, post, { now });

    expect(r).toEqual({ posted: 1, blockedAt: null });
    expect(store.posted).toEqual([1]);
    expect(post).toHaveBeenCalledTimes(1);
    expect(post.mock.calls[0]![0]!.title).toBe("v1.1.0 — release 1");
  });

  it("posts exactly one release per tick, so a backfill is paced", async () => {
    // ⚠️ The reason this tick is not batched like warLogTick: the first run
    // after a backfill has 25 rows, and 25 messages at once is a wall.
    const store = fakeStore([row(1), row(2), row(3)]);
    const post = vi.fn<(e: APIEmbed) => Promise<void>>().mockResolvedValue(undefined);

    await releaseTick(store, post, { now });
    await releaseTick(store, post, { now });

    expect(store.posted).toEqual([1, 2]);
  });

  it("does nothing when the queue is empty", async () => {
    const store = fakeStore([]);
    const post = vi.fn<(e: APIEmbed) => Promise<void>>().mockResolvedValue(undefined);

    const r = await releaseTick(store, post, { now });

    expect(r).toEqual({ posted: 0, blockedAt: null });
    expect(post).not.toHaveBeenCalled();
  });

  it("does not mark a release posted when the post fails", async () => {
    const store = fakeStore([row(1)]);
    const post = vi.fn<(e: APIEmbed) => Promise<void>>().mockRejectedValue(new Error("discord is down"));
    const onError = vi.fn();

    const r = await releaseTick(store, post, { now, onError });

    expect(r).toEqual({ posted: 0, blockedAt: 1 });
    expect(store.posted).toEqual([]);
    expect(onError).toHaveBeenCalledTimes(1);
  });

  it("blocks rather than skipping ahead, so the history keeps its order", async () => {
    const store = fakeStore([row(1), row(2)]);
    const post = vi.fn(async (e: APIEmbed) => {
      if (e.title?.includes("1.1.0")) throw new Error("discord is down");
    });

    await releaseTick(store, post, { now });
    await releaseTick(store, post, { now });

    expect(store.posted).toEqual([]);
  });

  it("leaves a multi-embed release unmarked when a later embed fails", async () => {
    // ⚠️ Re-posts the whole release next tick, duplicating the first embed.
    // Chosen over marking it posted, which would lose the rest permanently.
    const store = fakeStore([row(1, { body: "x".repeat(9000) })]);
    let calls = 0;
    const post = vi.fn(async () => {
      calls += 1;
      if (calls === 2) throw new Error("discord is down");
    });

    const r = await releaseTick(store, post, { now });

    expect(r.blockedAt).toBe(1);
    expect(store.posted).toEqual([]);
    expect(calls).toBe(2);
  });
});
