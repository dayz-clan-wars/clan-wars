import { describe, it, expect, vi } from "vitest";
import type { APIEmbed } from "discord.js";
import { hitFeedTick } from "../src/hit-feed-tick.js";
import type { CursorFeedStore } from "../src/cursor-feed.js";
import type { HitFeedItem } from "../src/hit-feed-embed.js";

const site = "https://dayzclanwars.com";
const item = (eventId: number, over: Partial<HitFeedItem> = {}): HitFeedItem => ({
  eventId, occurredAt: new Date("2026-09-12T01:00:00Z"), startedAt: new Date("2026-09-12T01:00:00Z"),
  attacker: { gamertag: `A${eventId}`, tag: null, texture: null },
  victim: { gamertag: `V${eventId}`, tag: null, texture: null },
  weapon: null, friendlyFire: false, suppressed: false,
  hits: [], totalDamage: null, victimHpAfter: null,
  ...over,
});

/** An in-memory store: `cursor` null means never seeded. */
function fakeStore(items: HitFeedItem[], cursor: number | null): CursorFeedStore<HitFeedItem> & { at: () => number | null } {
  let c = cursor;
  return {
    at: () => c,
    seeded: async () => c !== null,
    head: async () => Math.max(0, ...items.map((i) => i.eventId)),
    cursor: async () => c ?? 0,
    readAfter: async (after, limit) => items.filter((i) => i.eventId > after).sort((a, b) => a.eventId - b.eventId).slice(0, limit),
    markPosted: async (id) => { c = id; },
  };
}

describe("hitFeedTick", () => {
  it("⚠️ the first run seeds the cursor at the head and posts nothing — history never floods the channel", async () => {
    const store = fakeStore([item(10), item(20)], null);
    const post = vi.fn(async () => {});
    const r = await hitFeedTick(store, post, { siteBaseUrl: site });
    expect(r).toEqual({ posted: 0, blockedAt: null, seeded: true });
    expect(post).not.toHaveBeenCalled();
    expect(store.at()).toBe(20);
  });

  it("posts an unsuppressed engagement", async () => {
    const store = fakeStore([item(10)], 0);
    const post = vi.fn(async () => {});
    const r = await hitFeedTick(store, post, { siteBaseUrl: site });
    expect(r).toEqual({ posted: 1, blockedAt: null, seeded: false });
    expect(post).toHaveBeenCalledTimes(1);
    expect(store.at()).toBe(10);
  });

  it("⚠️ declines a suppressed engagement — it belongs to #kill-feed — but still advances the cursor past it", async () => {
    const store = fakeStore([item(10, { suppressed: true }), item(20)], 0);
    const post = vi.fn<(e: APIEmbed) => Promise<void>>(async () => {});
    const r = await hitFeedTick(store, post, { siteBaseUrl: site });
    expect(r).toEqual({ posted: 1, blockedAt: null, seeded: false });
    expect(post).toHaveBeenCalledTimes(1);
    expect(store.at()).toBe(20);
  });

  it("a run of entirely suppressed engagements advances the cursor to the end without posting anything", async () => {
    const store = fakeStore([item(10, { suppressed: true }), item(20, { suppressed: true })], 0);
    const post = vi.fn(async () => {});
    const r = await hitFeedTick(store, post, { siteBaseUrl: site });
    expect(r).toEqual({ posted: 0, blockedAt: null, seeded: false });
    expect(post).not.toHaveBeenCalled();
    expect(store.at()).toBe(20);
  });

  it("stops at the first failure and leaves the cursor on the last success", async () => {
    const store = fakeStore([item(10), item(20), item(30)], 0);
    const post = vi.fn(async (e: APIEmbed) => { if (e.title?.startsWith("A20")) throw new Error("discord is down"); });
    const onError = vi.fn();
    const r = await hitFeedTick(store, post, { siteBaseUrl: site, onError });
    expect(r).toEqual({ posted: 1, blockedAt: 20, seeded: false });
    expect(store.at()).toBe(10);
    expect(onError).toHaveBeenCalledWith(20, expect.any(Error));
  });
});
