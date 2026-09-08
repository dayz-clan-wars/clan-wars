import { describe, it, expect, vi } from "vitest";
import type { APIEmbed } from "discord.js";
import { killFeedTick, type KillFeedStore } from "../src/kill-feed-tick.js";
import type { KillFeedItem } from "../src/kill-feed-embed.js";

const site = "https://dayzclanwars.com";
const item = (eventId: number): KillFeedItem => ({
  eventId, occurredAt: new Date("2026-09-08T01:00:00Z"),
  killer: { gamertag: `K${eventId}`, tag: null, texture: null }, victim: { gamertag: `V${eventId}`, tag: null, texture: null },
  weapon: null, distanceM: null, friendlyFire: false, tally: { killerKills: 1, victimDeaths: 1, season: null },
});

/** An in-memory store: `cursor` null means never seeded. */
function fakeStore(items: KillFeedItem[], cursor: number | null): KillFeedStore & { at: () => number | null } {
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

describe("killFeedTick", () => {
  it("⚠️ the first run seeds the cursor at the head and posts nothing — history never floods the channel", async () => {
    const store = fakeStore([item(10), item(20), item(30)], null);
    const post = vi.fn(async () => {});
    const r = await killFeedTick(store, post, { siteBaseUrl: site });
    expect(r).toEqual({ posted: 0, blockedAt: null, seeded: true });
    expect(post).not.toHaveBeenCalled();
    expect(store.at()).toBe(30);
  });

  it("posts every kill after the cursor, oldest first, advancing as it goes", async () => {
    const store = fakeStore([item(10), item(20), item(30)], 10);
    const post = vi.fn<(e: APIEmbed) => Promise<void>>(async () => {});
    const r = await killFeedTick(store, post, { siteBaseUrl: site });
    expect(r).toEqual({ posted: 2, blockedAt: null, seeded: false });
    expect(post.mock.calls.map(([e]) => e.title)).toEqual(["K20", "K30"]);
    expect(store.at()).toBe(30);
  });

  it("stops at the first failure and leaves the cursor on the last success", async () => {
    const store = fakeStore([item(10), item(20), item(30)], 0);
    const post = vi.fn(async (e: { title?: string }) => { if (e.title === "K20") throw new Error("discord is down"); });
    const onError = vi.fn();
    const r = await killFeedTick(store, post, { siteBaseUrl: site, onError });
    expect(r).toEqual({ posted: 1, blockedAt: 20, seeded: false });
    expect(store.at()).toBe(10);
    expect(onError).toHaveBeenCalledWith(20, expect.any(Error));
  });

  it("honours the batch size", async () => {
    const store = fakeStore([item(1), item(2), item(3)], 0);
    const r = await killFeedTick(store, async () => {}, { siteBaseUrl: site, batchSize: 2 });
    expect(r.posted).toBe(2);
    expect(store.at()).toBe(2);
  });
});
