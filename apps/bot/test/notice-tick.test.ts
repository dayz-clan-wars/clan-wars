import { describe, it, expect, vi } from "vitest";
import { NOTICE_MAX_ATTEMPTS } from "@factions/roster/internal";
import type { NoticeStore, QueuedNotice } from "@factions/roster/internal";
import { noticeTick, type NoticeSender } from "../src/notice-tick.js";

const now = new Date("2026-09-06T12:00:00Z");

const row = (id: number, discordTargetId: string, overrides: Partial<QueuedNotice> = {}): QueuedNotice => ({
  id,
  factionId: 1,
  target: "channel",
  discordTargetId,
  kind: "left",
  occurredAt: now,
  payload: { gamertag: "X" },
  attempts: 0,
  ...overrides,
});

/** An in-memory NoticeStore whose queue behaves like the real one. */
function fakeStore(rows: QueuedNotice[]): NoticeStore & { posted: number[]; attempts: Map<number, number> } {
  const posted: number[] = [];
  const failed = new Set<number>();
  const attempts = new Map<number, number>();
  return {
    posted,
    attempts,
    readUnposted: async (limit) =>
      rows.filter((r) => !posted.includes(r.id) && !failed.has(r.id)).sort((a, b) => a.id - b.id).slice(0, limit)
        .map((r) => ({ ...r, attempts: attempts.get(r.id) ?? r.attempts })),
    markPosted: async (id) => { posted.push(id); },
    markAttempt: async (id) => {
      const n = (attempts.get(id) ?? 0) + 1;
      attempts.set(id, n);
      if (n >= NOTICE_MAX_ATTEMPTS) failed.add(id);
      return n;
    },
  };
}

describe("noticeTick", () => {
  it("posts a channel row that has no clan behind it to its own target", async () => {
    // The achievements wall: factionId null, the channel id frozen at write time.
    const store = fakeStore([row(1, "wall-1", { factionId: null, kind: "achievement", payload: { key: "sniper", name: "Sniper", description: "d", ownerKind: "clan", ownerName: "Bears", clanTag: "BEAR", public: true } })]);
    const send = vi.fn<NoticeSender>(async () => {});
    const r = await noticeTick(store, send, { now });
    expect(r).toMatchObject({ posted: 1, failed: 0 });
    expect(send.mock.calls[0]![1]).toBe("wall-1");
  });

  it("posts in id order per target and marks each posted", async () => {
    const store = fakeStore([row(1, "chan-a"), row(2, "chan-a"), row(3, "chan-b")]);
    const send = vi.fn<NoticeSender>().mockResolvedValue(undefined);

    const r = await noticeTick(store, send, { now });

    expect(r.posted).toBe(3);
    expect(r.failed).toBe(0);
    expect(store.posted).toEqual([1, 2, 3]);
    expect(send.mock.calls.map((c) => c[1])).toEqual(["chan-a", "chan-a", "chan-b"]);
  });

  it("a throwing target does not block another target's rows", async () => {
    const store = fakeStore([row(1, "chan-a"), row(2, "chan-b"), row(3, "chan-a")]);
    const send = vi.fn<NoticeSender>(async (_target, id) => {
      if (id === "chan-a") throw new Error("discord down for chan-a");
    });

    const r = await noticeTick(store, send, { now });

    expect(store.posted).toEqual([2]);
    expect(r.posted).toBe(1);
    expect(r.blockedTargets).toEqual(["chan-a"]);
  });

  it("fails a row after three attempts, and later rows for that target still post next tick", async () => {
    const store = fakeStore([row(1, "chan-a"), row(2, "chan-a")]);
    const onError = vi.fn();
    const failingSend = vi.fn<NoticeSender>(async () => { throw new Error("nope"); });

    await noticeTick(store, failingSend, { now, onError });
    await noticeTick(store, failingSend, { now, onError });
    const r3 = await noticeTick(store, failingSend, { now, onError });

    expect(r3.failed).toBe(1);
    expect(onError).toHaveBeenCalledTimes(3);
    expect(onError.mock.calls[2]).toEqual([1, 3, expect.any(Error)]);

    // Row 1 is now failed and no longer read; row 2 should post on this next tick.
    const send = vi.fn<NoticeSender>().mockResolvedValue(undefined);
    const r4 = await noticeTick(store, send, { now });
    expect(r4.posted).toBe(1);
    expect(store.posted).toEqual([2]);
  });

  it("calls markPosted only after a successful send", async () => {
    const store = fakeStore([row(1, "chan-a")]);
    const markPosted = vi.spyOn(store, "markPosted");
    const send = vi.fn<NoticeSender>().mockResolvedValue(undefined);

    await noticeTick(store, send, { now });

    expect(markPosted).toHaveBeenCalledWith(1, now);
  });

  it("does nothing, quietly, on an empty queue", async () => {
    const store = fakeStore([]);
    const send = vi.fn();
    const r = await noticeTick(store, send, { now });
    expect(r).toEqual({ posted: 0, failed: 0, blockedTargets: [] });
    expect(send).not.toHaveBeenCalled();
  });
});
