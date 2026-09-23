import { describe, it, expect } from "vitest";
import { banAnnouncementText, type BanAnnouncement } from "../src/ban-announce-text.js";

describe("banAnnouncementText", () => {
  it("applied / hub_combat names the Hub", () => {
    expect(banAnnouncementText({ kind: "applied", gamertag: "Ay", reason: "hub_combat", expiresAt: "2026-09-22T13:00:00Z" }))
      .toMatch(/^🔨 \*\*Ay\*\* banned until .+ — combat at the Fast Travel Hub\.$/u);
  });
  it("applied / unlinked_pc: playing on PC without a linked account", () => {
    const a: BanAnnouncement = { kind: "applied", gamertag: "Wolfie", reason: "unlinked_pc", expiresAt: null };
    expect(banAnnouncementText(a))
      .toBe("🔨 **Wolfie** banned — playing on PC without a linked account. Link your account to lift it.");
  });

  it("applied / unlinked_pc ignores expiresAt when set — the message never names one", () => {
    const a: BanAnnouncement = { kind: "applied", gamertag: "Wolfie", reason: "unlinked_pc", expiresAt: "2026-09-20T00:00:00.000Z" };
    expect(banAnnouncementText(a))
      .toBe("🔨 **Wolfie** banned — playing on PC without a linked account. Link your account to lift it.");
  });

  it("applied / zone / permanent", () => {
    const a: BanAnnouncement = { kind: "applied", gamertag: "Bear1", reason: "zone", expiresAt: null };
    expect(banAnnouncementText(a)).toBe("🔨 **Bear1** banned permanently — base-zone enforcement.");
  });

  it("applied / zone / expires — renders a live Discord timestamp token, not a static date", () => {
    const a: BanAnnouncement = { kind: "applied", gamertag: "Bear1", reason: "zone", expiresAt: "2026-09-20T14:00:00.000Z" };
    expect(banAnnouncementText(a)).toBe("🔨 **Bear1** banned until <t:1789912800:F> — base-zone enforcement.");
  });

  /**
   * ⚠️ Not `formatDate` (removed) — that fallback rendered "NaN undefined
   * NaN" on an unparseable expiry, which is not a truthful line. Same
   * null-degrade pattern as `war-log-text.ts`'s `season_closed`: drop the
   * clause rather than post a garbled date.
   */
  it("applied / zone / an unrepresentable expiry drops the clause rather than posting a garbled date", () => {
    const a: BanAnnouncement = { kind: "applied", gamertag: "Bear1", reason: "zone", expiresAt: "not-a-real-date" };
    expect(banAnnouncementText(a)).toBe("🔨 **Bear1** banned — base-zone enforcement.");
  });

  // ⚠️ Deliberate, not a formality: this is the arm a future pass might
  // "finish the job" on by linking the gamertag to a player page. It stays
  // unlinked — frozen player-controlled text that may not resolve to a page
  // at all — per the two warnings above `banAnnouncementText`.
  it("never links the gamertag, even one shaped like an existing player's", () => {
    const a: BanAnnouncement = { kind: "applied", gamertag: "SomePlayer", reason: "zone", expiresAt: null };
    const line = banAnnouncementText(a);
    expect(line).toContain("**SomePlayer**");
    expect(line).not.toContain("[SomePlayer]");
    expect(line).not.toMatch(/\]\(</);
  });

  it("lifted / unlinked_pc: account linked", () => {
    const a: BanAnnouncement = { kind: "lifted", gamertag: "Wolfie", reason: "unlinked_pc", expiresAt: null };
    expect(banAnnouncementText(a)).toBe("🔓 **Wolfie** unbanned — account linked.");
  });

  it("lifted / zone: does not claim a reason it does not know", () => {
    const a: BanAnnouncement = { kind: "lifted", gamertag: "Bear1", reason: "zone", expiresAt: null };
    expect(banAnnouncementText(a)).toBe("🔓 **Bear1** unbanned.");
  });

  it("lifted / zone ignores expiresAt", () => {
    const a: BanAnnouncement = { kind: "lifted", gamertag: "Bear1", reason: "zone", expiresAt: "2026-09-20T00:00:00.000Z" };
    expect(banAnnouncementText(a)).toBe("🔓 **Bear1** unbanned.");
  });

  it("expired / unlinked_pc: ban served", () => {
    const a: BanAnnouncement = { kind: "expired", gamertag: "Wolfie", reason: "unlinked_pc", expiresAt: "2026-09-20T00:00:00.000Z" };
    expect(banAnnouncementText(a)).toBe("🔓 **Wolfie** unbanned — ban served.");
  });

  it("expired / zone: ban served", () => {
    const a: BanAnnouncement = { kind: "expired", gamertag: "Bear1", reason: "zone", expiresAt: "2026-09-20T00:00:00.000Z" };
    expect(banAnnouncementText(a)).toBe("🔓 **Bear1** unbanned — ban served.");
  });

  it("escapes markdown in a player-controlled gamertag so it cannot restyle the line", () => {
    const a: BanAnnouncement = { kind: "applied", gamertag: "**Bear1**_evil_`x`", reason: "zone", expiresAt: null };
    expect(banAnnouncementText(a))
      .toBe("🔨 **\\*\\*Bear1\\*\\*\\_evil\\_\\`x\\`** banned permanently — base-zone enforcement.");
  });

  it("escapes markdown in a gamertag for the unlinked_pc applied line too", () => {
    const a: BanAnnouncement = { kind: "applied", gamertag: "a_b*c", reason: "unlinked_pc", expiresAt: null };
    expect(banAnnouncementText(a))
      .toBe("🔨 **a\\_b\\*c** banned — playing on PC without a linked account. Link your account to lift it.");
  });
});
