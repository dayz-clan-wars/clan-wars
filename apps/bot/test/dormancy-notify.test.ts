import { describe, it, expect, vi } from "vitest";
import { formatDormancyDm, notifyDormancy } from "../src/dormancy-notify.js";
import type { DormancyNotice } from "../src/dormancy-tick.js";

const common = {
  factionId: 1, leaderDiscordId: "d1", name: "Bears", tag: "BEAR",
  dormantAfterMs: 604_800_000,
};
// Typed as the "dormant" branch specifically, not the DormancyNotice union:
// disbandAt only exists on that branch, and these tests read it directly.
const base: Extract<DormancyNotice, { kind: "dormant" }> = {
  ...common, kind: "dormant",
  disbandAt: new Date("2026-09-16T12:00:00Z"),
};
const revived: DormancyNotice = { ...common, kind: "revive" };

describe("formatDormancyDm", () => {
  it("tells a dormant leader what happened, what to do, and the deadline", () => {
    const msg = formatDormancyDm(base);
    expect(msg).toMatch(/Bears/);
    expect(msg).toMatch(/supplies/i);
    expect(msg).toMatch(/raise/i);
    expect(msg).toContain(`<t:${Math.floor(base.disbandAt.getTime() / 1000)}:R>`);
  });

  it("⚠️ interpolates the window rather than hardcoding 'seven days'", () => {
    // BOT_DORMANT_AFTER_MS is configuration; a message naming the wrong
    // number is worse than one that says nothing.
    expect(formatDormancyDm(base)).toMatch(/\b7 days\b/);
    expect(formatDormancyDm({ ...base, dormantAfterMs: 3 * 86_400_000 })).toMatch(/\b3 days\b/);
    expect(formatDormancyDm({ ...base, dormantAfterMs: 86_400_000 })).toMatch(/\b1 day\b/);
  });

  it("⚠️ reports a sub-day window in hours rather than rounding down to 0 days", () => {
    // Math.round(ms / a day) floors anything under 12 hours to "0 days" —
    // production runs a multi-day window, but a staging BOT_DORMANT_AFTER_MS
    // of six hours must not tell a leader their flag has been down for zero
    // days. See the note above formatDuration.
    expect(formatDormancyDm({ ...base, dormantAfterMs: 6 * 3_600_000 })).toMatch(/\b6 hours\b/);
    expect(formatDormancyDm({ ...base, dormantAfterMs: 6 * 3_600_000 })).not.toMatch(/\bdays?\b/);
    expect(formatDormancyDm({ ...base, dormantAfterMs: 3_600_000 })).toMatch(/\b1 hour\b/);
  });

  it("confirms a revival", () => {
    const msg = formatDormancyDm(revived);
    expect(msg).toMatch(/Bears/);
    expect(msg).toMatch(/supplies/i);
    expect(msg).not.toMatch(/returns to the pool/i);
  });

  it("⚠️ never includes pole coordinates", () => {
    // A DM is screenshottable and the message does not need them. Same rule as
    // /faction info's members-only pole line.
    for (const notice of [base, revived]) {
      expect(formatDormancyDm(notice)).not.toMatch(/\d+\.\d+:\d+\.\d+:\d+\.\d+/);
    }
  });
});

describe("notifyDormancy", () => {
  it("⚠️ sends with an empty channel id, so there is no public fallback", async () => {
    // `send` falls back to posting in a channel when a DM fails. For dormancy
    // that fallback would announce whose base is undefended, so it must not be
    // reachable: an empty channel id makes the fallback throw instead.
    const send = vi.fn().mockResolvedValue(undefined);
    await notifyDormancy([base], send);
    expect(send).toHaveBeenCalledTimes(1);
    expect(send.mock.calls[0]![0]).toMatchObject({ discordId: "d1", channelId: "" });
  });

  it("⚠️ a failed DM is reported and never retried", async () => {
    // At-most-once, deliberately: the transition has already been written, so
    // there is no state that would tell a later tick to try again — and
    // re-deriving one would re-DM every dormant faction on every tick after
    // any transient Discord failure.
    const send = vi.fn().mockRejectedValue(new Error("DMs closed"));
    const onError = vi.fn();
    expect(await notifyDormancy([base], send, onError)).toBe(0);
    expect(onError).toHaveBeenCalledTimes(1);
  });

  it("one unreachable leader does not stop the others being told", async () => {
    const send = vi.fn()
      .mockRejectedValueOnce(new Error("DMs closed"))
      .mockResolvedValueOnce(undefined);
    expect(await notifyDormancy([base, { ...base, factionId: 2, leaderDiscordId: "d2" }], send, vi.fn())).toBe(1);
    expect(send).toHaveBeenCalledTimes(2);
  });
});
