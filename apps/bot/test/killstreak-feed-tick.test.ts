import { describe, it, expect, vi } from "vitest";
import type { APIEmbed } from "discord.js";
import { killstreakFeedTick, DEFAULT_KILLSTREAK_EVERY } from "../src/killstreak-feed-tick.js";
import type { KillstreakFeedItem } from "../src/killstreak-feed-embed.js";
import type { CursorFeedStore } from "../src/cursor-feed.js";

const site = "https://dayzclanwars.com";
const item = (eventId: number, streak: number | null): KillstreakFeedItem => ({
  eventId, occurredAt: new Date("2026-09-08T01:00:00Z"), startedAt: new Date("2026-09-08T00:00:00Z"),
  killer: { gamertag: `K${eventId}`, tag: null, texture: null },
  streak, victims: streak === null ? [] : Array.from({ length: streak }, (_, n) => `V${n}`),
});

/** An in-memory store: `cursor` null means never seeded. */
function fakeStore(items: KillstreakFeedItem[], cursor: number | null): CursorFeedStore<KillstreakFeedItem> & { at: () => number | null } {
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

describe("killstreakFeedTick", () => {
  it("posts a milestone streak — every Nth kill", async () => {
    const store = fakeStore([item(10, 3)], 0);
    const post = vi.fn<(e: APIEmbed) => Promise<void>>(async () => {});
    const r = await killstreakFeedTick(store, post, { siteBaseUrl: site, every: 3 });
    expect(r).toEqual({ posted: 1, blockedAt: null, seeded: false });
    expect(post).toHaveBeenCalledTimes(1);
    expect(store.at()).toBe(10);
  });

  it("declines a non-milestone streak but STILL ADVANCES THE CURSOR — otherwise the feed stalls on every ordinary kill", async () => {
    const store = fakeStore([item(10, 1), item(20, 2), item(30, 4)], 0);
    const post = vi.fn(async () => {});
    const r = await killstreakFeedTick(store, post, { siteBaseUrl: site, every: 3 });
    expect(r).toEqual({ posted: 0, blockedAt: null, seeded: false });
    expect(post).not.toHaveBeenCalled();
    // The cursor moved past all three declined items, not just the last one.
    expect(store.at()).toBe(30);
  });

  it("declines a friendly-fire kill (streak: null)", async () => {
    const store = fakeStore([item(10, null)], 0);
    const post = vi.fn(async () => {});
    const r = await killstreakFeedTick(store, post, { siteBaseUrl: site, every: 3 });
    expect(post).not.toHaveBeenCalled();
    expect(r.posted).toBe(0);
    expect(store.at()).toBe(10);
  });

  it("⚠️ streak: 0 declines — 0 % 3 === 0 must not fire the render through the modulo", async () => {
    const store = fakeStore([item(10, 0)], 0);
    const post = vi.fn(async () => {});
    const r = await killstreakFeedTick(store, post, { siteBaseUrl: site, every: 3 });
    expect(post).not.toHaveBeenCalled();
    expect(r.posted).toBe(0);
    expect(store.at()).toBe(10);
  });

  it("an `every` of 0 falls back to the default rather than dividing by zero", async () => {
    const store = fakeStore([item(10, DEFAULT_KILLSTREAK_EVERY)], 0);
    const post = vi.fn<(e: APIEmbed) => Promise<void>>(async () => {});
    const r = await killstreakFeedTick(store, post, { siteBaseUrl: site, every: 0 });
    expect(r.posted).toBe(1);
    expect(post).toHaveBeenCalledTimes(1);
  });

  it("a negative `every` falls back to the default rather than firing on every kill", async () => {
    const store = fakeStore([item(10, 1), item(20, 2)], 0);
    const post = vi.fn(async () => {});
    const r = await killstreakFeedTick(store, post, { siteBaseUrl: site, every: -1 });
    // Neither streak (1, 2) is a multiple of DEFAULT_KILLSTREAK_EVERY (3).
    expect(post).not.toHaveBeenCalled();
    expect(r.posted).toBe(0);
  });
});
