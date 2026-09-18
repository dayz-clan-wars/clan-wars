import { describe, it, expect } from "vitest";
import { banAnnouncementText, type BanAnnouncement } from "../src/ban-announce-text.js";

describe("banAnnouncementText", () => {
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

  it("applied / zone / expires — renders the formatDate convention (d MMM yyyy, UTC)", () => {
    const a: BanAnnouncement = { kind: "applied", gamertag: "Bear1", reason: "zone", expiresAt: "2026-09-20T14:00:00.000Z" };
    expect(banAnnouncementText(a)).toBe("🔨 **Bear1** banned until 20 Sep 2026 — base-zone enforcement.");
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
