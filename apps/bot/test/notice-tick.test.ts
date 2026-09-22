import { describe, it, expect, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { NOTICE_MAX_ATTEMPTS } from "@factions/roster/internal";
import type { NoticeStore, QueuedNotice } from "@factions/roster/internal";
import { noticeTick, noticeMessage, type NoticeSender } from "../src/notice-tick.js";

// Same technique as restart-wiring.test.ts: read discord.ts's own source rather than
// exercising the real tick loop (which needs a live Discord client and Postgres).
const discordSrc = readFileSync(join(import.meta.dirname, "..", "src", "discord.ts"), "utf8");

describe("noticeTick wiring", () => {
  // ⚠️ Dropping this argument, or wiring it to @factions/domain's DORMANT_AFTER_MS
  // instead of cfg.dormantAfterMs, leaves dormant_inactive naming a number this
  // server does not run — silently, since loadConfig would still accept it and
  // nothing would log the mismatch. See the task-9 report.
  it("passes cfg.dormantAfterMs into the notice tick, not the domain constant", () => {
    expect(discordSrc).toMatch(/await noticeTick\(noticeStore, noticeSender, \{[^}]*dormantAfterMs: cfg\.dormantAfterMs/su);
  });
});

const now = new Date("2026-09-06T12:00:00Z");
const site = "https://dayzclanwars.com";
// Deliberately NOT 7 days (the domain constant): if noticeMessage/noticeTick ever
// regressed to defaulting dormantAfterMs from @factions/domain instead of requiring
// it from the caller, a dormant_inactive assertion against this value would catch it.
const dormantAfterMs = 3 * 86_400_000;

const row = (id: number, discordTargetId: string, overrides: Partial<QueuedNotice> = {}): QueuedNotice => ({
  id,
  factionId: 1,
  target: "channel",
  discordTargetId,
  discordRoleId: null,
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
    const r = await noticeTick(store, send, { now, siteBaseUrl: site, dormantAfterMs });
    expect(r).toMatchObject({ posted: 1, failed: 0 });
    expect(send.mock.calls[0]![1]).toBe("wall-1");
    // The public wall gets the card alone: no mention, no text line.
    expect(send.mock.calls[0]![2]).toBe("");
    expect(send.mock.calls[0]![3]![0]!.description).toBe(`**[BEAR](<${site}/clans/BEAR>)** unlocked **Sniper** · d`);
  });

  it("an achievement in a clan channel is a mention plus the card; in a DM the card alone; any other kind the text line", () => {
    const payload = { key: "sniper", name: "Sniper", description: "d", ownerKind: "player", ownerName: "111111111111111111", gamertag: "Racer", clanTag: "BEAR" };
    const channel = noticeMessage(row(1, "chan", { kind: "achievement", payload }), site, dormantAfterMs);
    expect(channel.content).toBe("<@111111111111111111>");
    expect(channel.embeds![0]!.thumbnail!.url).toBe("https://dayzclanwars.com/achievements/unlocked/sniper.png");
    const dm = noticeMessage(row(2, "user", { kind: "achievement", target: "dm", payload }), site, dormantAfterMs);
    expect(dm.content).toBe("");
    expect(dm.embeds).toHaveLength(1);
    const left = noticeMessage(row(3, "chan"), site, dormantAfterMs);
    expect(left.content).toContain("X");
    expect(left.embeds).toBeUndefined();
  });

  it("opens an alert kind with the clan role ping, and leaves every other kind alone", async () => {
    const roleId = "role-1";
    const alert = noticeMessage(row(1, "chan", { discordRoleId: roleId, kind: "intruder", payload: { gamertag: "Sasha", distance: 42 } }), site, dormantAfterMs);
    expect(alert.content).toBe(`<@&${roleId}> 👁 [Sasha](<${site}/players/Sasha>) (not a member) was seen 42 m from your base — <t:1788696000:R>`);
    expect(alert.mentionRoleId).toBe(roleId);

    // A membership line is not an emergency: same channel, same role on the
    // row, no ping.
    const quiet = noticeMessage(row(2, "chan", { discordRoleId: roleId }), site, dormantAfterMs);
    expect(quiet.content).toBe(`➖ [X](<${site}/players/X>) left`);
    expect(quiet.mentionRoleId).toBeUndefined();
  });

  it("⚠️ a DM never carries a role ping, and a clan with no role column yet still gets the alert unpinged", () => {
    // The solo twin of an intruder alert: a DM is already a notification, and
    // a solo player has no role. The leftJoin in readUnposted still hands the
    // row a role id when the player happens to be in a clan.
    const dm = noticeMessage(row(1, "user", { target: "dm", discordRoleId: "role-1", kind: "solo_intruder", payload: { gamertag: "Sasha", distance: 14 } }), site, dormantAfterMs);
    expect(dm.content).toBe(`👁 [Sasha](<${site}/players/Sasha>) (not a member) was seen 14 m from your base — <t:1788696000:R>`);
    expect(dm.mentionRoleId).toBeUndefined();

    const noRole = noticeMessage(row(2, "chan", { kind: "intruder", payload: { gamertag: "Sasha", distance: 42 } }), site, dormantAfterMs);
    expect(noRole.content).toBe(`👁 [Sasha](<${site}/players/Sasha>) (not a member) was seen 42 m from your base — <t:1788696000:R>`);
    expect(noRole.mentionRoleId).toBeUndefined();
  });

  // ⚠️ Uses the module-level `dormantAfterMs` (3 days, not the domain constant's 7) so
  // this fails loudly if noticeMessage/noticeTick ever stop requiring the caller to pass
  // it — a silent fallback would render "7 days" here instead.
  it("threads dormantAfterMs from the caller into dormant_inactive, not the domain default", () => {
    const msg = noticeMessage(row(1, "chan", { kind: "dormant_inactive", payload: {} }), site, dormantAfterMs);
    expect(msg.content).toContain("3 days");
    expect(msg.content).not.toContain("7 days");
  });

  it("hands the sender the role to allow, so nothing else in the line can ping", async () => {
    const store = fakeStore([row(1, "chan", { discordRoleId: "role-1", kind: "flag_down", payload: { gamertag: "Sasha", raiderClan: "Wolves" } })]);
    const send = vi.fn<NoticeSender>().mockResolvedValue(undefined);
    await noticeTick(store, send, { now, siteBaseUrl: site, dormantAfterMs });
    expect(send.mock.calls[0]![4]).toBe("role-1");
  });

  it("posts in id order per target and marks each posted", async () => {
    const store = fakeStore([row(1, "chan-a"), row(2, "chan-a"), row(3, "chan-b")]);
    const send = vi.fn<NoticeSender>().mockResolvedValue(undefined);

    const r = await noticeTick(store, send, { now, siteBaseUrl: site, dormantAfterMs });

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

    const r = await noticeTick(store, send, { now, siteBaseUrl: site, dormantAfterMs });

    expect(store.posted).toEqual([2]);
    expect(r.posted).toBe(1);
    expect(r.blockedTargets).toEqual(["chan-a"]);
  });

  it("fails a row after three attempts, and later rows for that target still post next tick", async () => {
    const store = fakeStore([row(1, "chan-a"), row(2, "chan-a")]);
    const onError = vi.fn();
    const failingSend = vi.fn<NoticeSender>(async () => { throw new Error("nope"); });

    await noticeTick(store, failingSend, { now, siteBaseUrl: site, dormantAfterMs, onError });
    await noticeTick(store, failingSend, { now, siteBaseUrl: site, dormantAfterMs, onError });
    const r3 = await noticeTick(store, failingSend, { now, siteBaseUrl: site, dormantAfterMs, onError });

    expect(r3.failed).toBe(1);
    expect(onError).toHaveBeenCalledTimes(3);
    expect(onError.mock.calls[2]).toEqual([1, 3, expect.any(Error)]);

    // Row 1 is now failed and no longer read; row 2 should post on this next tick.
    const send = vi.fn<NoticeSender>().mockResolvedValue(undefined);
    const r4 = await noticeTick(store, send, { now, siteBaseUrl: site, dormantAfterMs });
    expect(r4.posted).toBe(1);
    expect(store.posted).toEqual([2]);
  });

  it("calls markPosted only after a successful send", async () => {
    const store = fakeStore([row(1, "chan-a")]);
    const markPosted = vi.spyOn(store, "markPosted");
    const send = vi.fn<NoticeSender>().mockResolvedValue(undefined);

    await noticeTick(store, send, { now, siteBaseUrl: site, dormantAfterMs });

    expect(markPosted).toHaveBeenCalledWith(1, now);
  });

  it("does nothing, quietly, on an empty queue", async () => {
    const store = fakeStore([]);
    const send = vi.fn();
    const r = await noticeTick(store, send, { now, siteBaseUrl: site, dormantAfterMs });
    expect(r).toEqual({ posted: 0, failed: 0, blockedTargets: [] });
    expect(send).not.toHaveBeenCalled();
  });

  it("renders the booster kit prompt with a link button and no custom_id", () => {
    const msg = noticeMessage({
      kind: "booster_kit_unchosen", target: "dm", occurredAt: new Date(),
      payload: { kitUrl: "https://example.test/kit" },
    }, "https://example.test", dormantAfterMs);
    expect(msg.content).toMatch(/kit/iu);
    expect(msg.components?.[0]?.components?.[0]).toMatchObject({ style: 5, url: "https://example.test/kit" });
    // ⚠️ A URL button carries no custom_id and must never be routed. A style: 2
    // button here would need an interaction handler and add state to the bot.
    expect(JSON.stringify(msg.components)).not.toContain("custom_id");
  });
});
