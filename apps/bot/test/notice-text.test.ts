import { describe, it, expect } from "vitest";
import { CLAN_NOTICE_KINDS } from "@factions/domain";
import { noticeText, RENDERERS, relativeAge, duration } from "../src/notice-text.js";

const now = new Date("2026-09-06T12:00:00Z");

describe("RENDERERS", () => {
  it("has exactly one renderer per CLAN_NOTICE_KINDS entry, and none for a kind not listed (spec §13)", () => {
    expect(Object.keys(RENDERERS).sort()).toEqual([...CLAN_NOTICE_KINDS].sort());
  });
});

describe("noticeText", () => {
  it("renders the §9.3 lines verbatim", () => {
    expect(noticeText({ kind: "flag_down", target: "channel", occurredAt: now, payload: { gamertag: "Wolfie", raiderClan: "Wolves" } }, now))
      .toBe("🚨 Your flag is down — lowered by Wolfie of Wolves. Re-raise within 24h or go dormant. Supplies paused.");
    expect(noticeText({ kind: "flag_down", target: "channel", occurredAt: now, payload: { gamertag: "Solo", raiderClan: null } }, now))
      .toBe("🚨 Your flag is down — lowered by Solo. Re-raise within 24h or go dormant. Supplies paused.");
    expect(noticeText({ kind: "defended", target: "channel", occurredAt: now, payload: { gamertag: "Bear1", durationSeconds: 11700 } }, now))
      .toBe("🛡️ Bear1 raised the flag. Defended — 3h 15m under siege. Supplies resume at next restart.");
    expect(noticeText({ kind: "non_member_raise", target: "channel", occurredAt: new Date(now.getTime() - 6 * 60_000), payload: { gamertag: "X" } }, now))
      .toBe("⚑ X (not a member) raised your flag at your base — 6 min ago");
    expect(noticeText({ kind: "kicked", target: "dm", occurredAt: now, payload: { clan: "Bears", until: "2026-09-08T00:00:00.000Z" } }, now))
      .toBe("You were removed from **Bears**. You can join a clan again on 8 Sep 2026.");
    expect(noticeText({ kind: "revived", target: "channel", occurredAt: now, payload: {} }, now)).toBe("☀️ The flag was raised. You're active again.");
  });

  it("never contains a coordinate even if a payload smuggled one past the type", () => {
    const text = noticeText({ kind: "joined", target: "channel", occurredAt: now, payload: { gamertag: "A", x: 12 } as never }, now);
    expect(text).not.toMatch(/12/u);
  });

  it("renders revived with a gamertag", () => {
    expect(noticeText({ kind: "revived", target: "channel", occurredAt: now, payload: { gamertag: "Bear1" } }, now))
      .toBe("☀️ Bear1 raised the flag. You're active again.");
  });

  it("renders dormant_raided and dormant_inactive fixed text", () => {
    expect(noticeText({ kind: "dormant_raided", target: "channel", occurredAt: now, payload: {} }, now))
      .toBe("💤 24 hours passed. You're dormant. Any member raising the flag brings you back.");
    expect(noticeText({ kind: "dormant_inactive", target: "channel", occurredAt: now, payload: {} }, now))
      .toBe("💤 No member has raised the flag in 7 days. You're dormant. Supplies stopped.");
  });

  it("renders disband_warning from its payload's days", () => {
    expect(noticeText({ kind: "disband_warning", target: "channel", occurredAt: now, payload: { days: 4 } }, now))
      .toBe("⚠️ 4 days until this clan is disbanded and the flag returns to the pool.");
  });

  it("renders colors_elsewhere and rebind_proposed", () => {
    expect(noticeText({ kind: "colors_elsewhere", target: "channel", occurredAt: now, payload: { gamertag: "X" } }, now))
      .toBe("🏴 Your flag is flying at a pole that isn't yours — raised by X");
    expect(noticeText({ kind: "rebind_proposed", target: "channel", occurredAt: now, payload: { gamertag: "X", link: "https://dayzclanwars.com/clan/settings" } }, now))
      .toBe("📦 X raised our flag at a new pole. Leader: confirm the move within 24h: https://dayzclanwars.com/clan/settings");
  });

  it("renders rebind_confirmed with the 3-day grace period", () => {
    expect(noticeText({ kind: "rebind_confirmed", target: "channel", occurredAt: now, payload: {} }, now))
      .toBe("📦 Moved. Supplies follow at the next restart. The old base goes public in 3 days.");
  });

  it("renders roster lines", () => {
    expect(noticeText({ kind: "joined", target: "channel", occurredAt: now, payload: { gamertag: "X" } }, now))
      .toBe("➕ X joined — pending until seen at the base");
    expect(noticeText({ kind: "became_full", target: "channel", occurredAt: now, payload: { gamertag: "X" } }, now))
      .toBe("✅ X is now a full member (seen at the base)");
    expect(noticeText({ kind: "left", target: "channel", occurredAt: now, payload: { gamertag: "X" } }, now))
      .toBe("➖ X left");
    expect(noticeText({ kind: "kicked", target: "channel", occurredAt: now, payload: { gamertag: "X", officer: "Y" } }, now))
      .toBe("🥾 X was kicked by Y");
    expect(noticeText({ kind: "promoted", target: "channel", occurredAt: now, payload: { gamertag: "X" } }, now))
      .toBe("⬆️ X promoted to officer");
    expect(noticeText({ kind: "demoted", target: "channel", occurredAt: now, payload: { gamertag: "X" } }, now))
      .toBe("⬇️ X demoted to member");
    expect(noticeText({ kind: "transferred", target: "channel", occurredAt: now, payload: { gamertag: "X", old: "Y" } }, now))
      .toBe("👑 X is now leader (transferred by Y)");
    expect(noticeText({ kind: "renamed", target: "channel", occurredAt: now, payload: { name: "Bears", tag: "BRS" } }, now))
      .toBe("✏️ We are now **Bears** [BRS].");
  });

  it("renders invite/request DMs", () => {
    expect(noticeText({ kind: "invited", target: "dm", occurredAt: now, payload: { clan: "Bears", tag: "BRS", link: "https://x/me" } }, now))
      .toBe("**Bears** invited you. Accept or decline: https://x/me");
    expect(noticeText({ kind: "request_accepted", target: "dm", occurredAt: now, payload: { clan: "Bears" } }, now))
      .toBe("**Bears** accepted your request. Go stand at the base to become a full member.");
    expect(noticeText({ kind: "request_declined", target: "dm", occurredAt: now, payload: { clan: "Bears" } }, now))
      .toBe("**Bears** declined your request.");
    expect(noticeText({ kind: "pending_expired", target: "dm", occurredAt: now, payload: { clan: "Bears" } }, now))
      .toBe("Your spot in **Bears** expired — you were never seen at the base.");
  });

  it("renders solo lines", () => {
    expect(noticeText({ kind: "solo_non_member_raise", target: "dm", occurredAt: new Date(now.getTime() - 6 * 60_000), payload: { gamertag: "X" } }, now))
      .toBe("⚑ X (not a member) raised your flag at your base — 6 min ago");
    expect(noticeText({ kind: "solo_lapsed", target: "dm", occurredAt: now, payload: { link: "https://x/base" } }, now))
      .toBe("Your base declaration lapsed — no raise in 7 days. The pole goes public in 3 days unless you raise there and declare again: https://x/base");
  });

  it("renders a missing gamertag as someone", () => {
    expect(noticeText({ kind: "left", target: "channel", occurredAt: now, payload: {} }, now)).toBe("➖ someone left");
  });

  it("renders an all-digit gamertag as a mention", () => {
    expect(noticeText({ kind: "left", target: "channel", occurredAt: now, payload: { gamertag: "123456789012345678" } }, now))
      .toBe("➖ <@123456789012345678> left");
  });
});

describe("relativeAge", () => {
  it("renders minutes, hours, and days", () => {
    expect(relativeAge(new Date(now.getTime() - 6 * 60_000), now)).toBe("6 min ago");
    expect(relativeAge(new Date(now.getTime() - 2 * 3_600_000), now)).toBe("2 h ago");
    expect(relativeAge(new Date(now.getTime() - 3 * 86_400_000), now)).toBe("3 d ago");
  });
});

describe("duration", () => {
  it("renders hours and minutes", () => {
    expect(duration(11700)).toBe("3h 15m");
    expect(duration(60)).toBe("0h 1m");
  });
});
