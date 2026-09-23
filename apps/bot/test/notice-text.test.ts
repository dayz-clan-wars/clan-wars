import { describe, it, expect } from "vitest";
import { CLAN_NOTICE_KINDS, DORMANT_AFTER_MS, RAID_DEDUP_MS, REBIND_CONFIRM_MS } from "@factions/domain";
import { noticeText, RENDERERS, duration } from "../src/notice-text.js";

const now = new Date("2026-09-06T12:00:00Z");
const site = "https://dayzclanwars.com";

// The bot's config default equals the domain constant (config.ts mirrors it
// via DEFAULT_DORMANT_AFTER_MS); used here only as the value a real tick
// would thread through — never imported by notice-text.ts itself for the
// dormant_inactive number.
const dormantAfterMs = DORMANT_AFTER_MS;

describe("RENDERERS", () => {
  it("has exactly one renderer per CLAN_NOTICE_KINDS entry, and none for a kind not listed (spec §13)", () => {
    expect(Object.keys(RENDERERS).sort()).toEqual([...CLAN_NOTICE_KINDS].sort());
  });
});

describe("noticeText", () => {
  it("renders the §9.3 lines verbatim", () => {
    expect(noticeText({ kind: "flag_down", target: "channel", occurredAt: now, payload: { gamertag: "Wolfie", raiderClan: "Wolves" } }, site, dormantAfterMs))
      .toBe(`🚨 Your flag is down — lowered by [Wolfie](<${site}/players/Wolfie>) of Wolves. Re-raise within ${RAID_DEDUP_MS / 3_600_000}h or go dormant. Crate paused, spare flag still at your pole.`);
    expect(noticeText({ kind: "flag_down", target: "channel", occurredAt: now, payload: { gamertag: "Solo", raiderClan: null } }, site, dormantAfterMs))
      .toBe(`🚨 Your flag is down — lowered by [Solo](<${site}/players/Solo>). Re-raise within ${RAID_DEDUP_MS / 3_600_000}h or go dormant. Crate paused, spare flag still at your pole.`);
    expect(noticeText({ kind: "defended", target: "channel", occurredAt: now, payload: { gamertag: "Bear1", durationSeconds: 11700 } }, site, dormantAfterMs))
      .toBe(`🛡️ [Bear1](<${site}/players/Bear1>) raised the flag. Defended — 3h 15m under siege. Supplies resume at next restart.`);
    expect(noticeText({ kind: "non_member_raise", target: "channel", occurredAt: new Date(now.getTime() - 6 * 60_000), payload: { gamertag: "X" } }, site, dormantAfterMs))
      .toBe(`⚑ [X](<${site}/players/X>) (not a member) raised your flag at your base — <t:1788695640:R>`);
    expect(noticeText({ kind: "kicked", target: "dm", occurredAt: now, payload: { clan: "Bears", until: "2026-09-08T00:00:00.000Z" } }, site, dormantAfterMs))
      .toBe(`You were removed from **Bears**. You can join a clan again on <t:1788825600:F>.`);
    expect(noticeText({ kind: "revived", target: "channel", occurredAt: now, payload: {} }, site, dormantAfterMs)).toBe("☀️ The flag was raised. You're active again.");
  });

  it("never contains a coordinate even if a payload smuggled one past the type", () => {
    const text = noticeText({ kind: "joined", target: "channel", occurredAt: now, payload: { gamertag: "A", x: 12 } as never }, site, dormantAfterMs);
    expect(text).not.toMatch(/12/u);
  });

  it("renders revived with a gamertag", () => {
    expect(noticeText({ kind: "revived", target: "channel", occurredAt: now, payload: { gamertag: "Bear1" } }, site, dormantAfterMs))
      .toBe(`☀️ [Bear1](<${site}/players/Bear1>) raised the flag. You're active again.`);
  });

  it("renders dormant_raided from RAID_DEDUP_MS and dormant_inactive from the threaded config window, not a typed literal", () => {
    expect(noticeText({ kind: "dormant_raided", target: "channel", occurredAt: now, payload: {} }, site, dormantAfterMs))
      .toBe(`💤 ${RAID_DEDUP_MS / 3_600_000} hours passed. You're dormant. Any member raising the flag brings you back.`);
    expect(noticeText({ kind: "dormant_inactive", target: "channel", occurredAt: now, payload: {} }, site, dormantAfterMs))
      .toBe(`💤 No member has raised the flag in ${dormantAfterMs / 86_400_000} days. You're dormant. Crate stopped, spare flag still at your pole.`);
  });

  it("formats a sub-day dormancy window in hours, not '0 days'", () => {
    const line = noticeText({ kind: "dormant_inactive", target: "channel", occurredAt: now, payload: {} }, site, 6 * 3_600_000);
    expect(line).toContain("6 hours");
    expect(line).not.toContain("0 days");
  });

  it("renders disband_warning from its payload's days", () => {
    expect(noticeText({ kind: "disband_warning", target: "channel", occurredAt: now, payload: { days: 4 } }, site, dormantAfterMs))
      .toBe("⚠️ 4 days until this clan is disbanded and the flag returns to the pool.");
  });

  it("renders colors_elsewhere and rebind_proposed", () => {
    expect(noticeText({ kind: "colors_elsewhere", target: "channel", occurredAt: now, payload: { gamertag: "X" } }, site, dormantAfterMs))
      .toBe(`🏴 Your flag is flying at a pole that isn't yours — raised by [X](<${site}/players/X>)`);
    expect(noticeText({ kind: "rebind_proposed", target: "channel", occurredAt: now, payload: { gamertag: "X", link: "https://dayzclanwars.com/clan/settings" } }, site, dormantAfterMs))
      .toBe(`📦 [X](<${site}/players/X>) raised our flag at a new pole. Leader: confirm the move within ${REBIND_CONFIRM_MS / 3_600_000}h: [open it](<https://dayzclanwars.com/clan/settings>)`);
  });

  it("renders rebind_confirmed with the 3-day grace period", () => {
    expect(noticeText({ kind: "rebind_confirmed", target: "channel", occurredAt: now, payload: {} }, site, dormantAfterMs))
      .toBe("📦 Moved. Supplies follow at the next restart. The old base goes public in 3 days.");
  });

  it("renders roster lines", () => {
    expect(noticeText({ kind: "joined", target: "channel", occurredAt: now, payload: { gamertag: "X" } }, site, dormantAfterMs))
      .toBe(`➕ [X](<${site}/players/X>) joined — pending until seen at the base`);
    expect(noticeText({ kind: "became_full", target: "channel", occurredAt: now, payload: { gamertag: "X" } }, site, dormantAfterMs))
      .toBe(`✅ [X](<${site}/players/X>) is now a full member (seen at the base)`);
    expect(noticeText({ kind: "left", target: "channel", occurredAt: now, payload: { gamertag: "X" } }, site, dormantAfterMs))
      .toBe(`➖ [X](<${site}/players/X>) left`);
    expect(noticeText({ kind: "kicked", target: "channel", occurredAt: now, payload: { gamertag: "X", officer: "Y" } }, site, dormantAfterMs))
      .toBe(`🥾 [X](<${site}/players/X>) was kicked by [Y](<${site}/players/Y>)`);
    expect(noticeText({ kind: "promoted", target: "channel", occurredAt: now, payload: { gamertag: "X" } }, site, dormantAfterMs))
      .toBe(`⬆️ [X](<${site}/players/X>) promoted to officer`);
    expect(noticeText({ kind: "demoted", target: "channel", occurredAt: now, payload: { gamertag: "X" } }, site, dormantAfterMs))
      .toBe(`⬇️ [X](<${site}/players/X>) demoted to member`);
    expect(noticeText({ kind: "transferred", target: "channel", occurredAt: now, payload: { gamertag: "X", old: "Y" } }, site, dormantAfterMs))
      .toBe(`👑 [X](<${site}/players/X>) is now leader (transferred by [Y](<${site}/players/Y>))`);
    expect(noticeText({ kind: "renamed", target: "channel", occurredAt: now, payload: { name: "Bears", tag: "BRS" } }, site, dormantAfterMs))
      .toBe(`✏️ We are now **[Bears](<${site}/clans/BRS>)** [BRS].`);
  });

  it("renders invite/request DMs", () => {
    expect(noticeText({ kind: "invited", target: "dm", occurredAt: now, payload: { clan: "Bears", tag: "BRS", link: "https://x/me" } }, site, dormantAfterMs))
      .toBe(`**[Bears](<${site}/clans/BRS>)** [BRS] invited you. Accept or decline: [open it](<https://x/me>)`);
    expect(noticeText({ kind: "request_accepted", target: "dm", occurredAt: now, payload: { clan: "Bears" } }, site, dormantAfterMs))
      .toBe("**Bears** accepted your request. Go stand at the base to become a full member.");
    expect(noticeText({ kind: "request_declined", target: "dm", occurredAt: now, payload: { clan: "Bears" } }, site, dormantAfterMs))
      .toBe("**Bears** declined your request.");
    expect(noticeText({ kind: "pending_expired", target: "dm", occurredAt: now, payload: { clan: "Bears" } }, site, dormantAfterMs))
      .toBe("Your spot in **Bears** expired — you were never seen at the base.");
  });

  it("renders solo lines", () => {
    expect(noticeText({ kind: "solo_non_member_raise", target: "dm", occurredAt: new Date(now.getTime() - 6 * 60_000), payload: { gamertag: "X" } }, site, dormantAfterMs))
      .toBe(`⚑ [X](<${site}/players/X>) (not a member) raised your flag at your base — <t:1788695640:R>`);
    expect(noticeText({ kind: "solo_lapsed", target: "dm", occurredAt: now, payload: { link: "https://x/base" } }, site, dormantAfterMs))
      .toBe("Your base declaration lapsed — no raise in 7 days. The pole goes public in 3 days unless you raise there and declare again: [open it](<https://x/base>)");
  });

  it("renders a missing gamertag as someone", () => {
    expect(noticeText({ kind: "left", target: "channel", occurredAt: now, payload: {} }, site, dormantAfterMs)).toBe("➖ someone left");
  });

  it("renders an all-digit gamertag as a mention, never a link", () => {
    expect(noticeText({ kind: "left", target: "channel", occurredAt: now, payload: { gamertag: "123456789012345678" } }, site, dormantAfterMs))
      .toBe("➖ <@123456789012345678> left");
  });

  it("renders the intruder line with distance and a live age token", () => {
    expect(noticeText({ kind: "intruder", target: "channel", occurredAt: new Date(now.getTime() - 6 * 60_000), payload: { gamertag: "Sasha", distance: 42 } }, site, dormantAfterMs))
      .toBe(`👁 [Sasha](<${site}/players/Sasha>) (not a member) was seen 42 m from your base — <t:1788695640:R>`);
  });
  it("renders an intruder sighting with a live token, not a baked age", () => {
    const occurredAt = new Date("2026-09-21T14:30:00.000Z");
    const line = noticeText({
      kind: "intruder",
      target: "channel",
      occurredAt,
      payload: { gamertag: "SomePlayer", distance: 60 },
    }, site, dormantAfterMs);
    expect(line).toContain("<t:1790001000:R>");
    expect(line).not.toContain("min ago");
  });
  it("links a gamertag in a channel notice", () => {
    const line = noticeText({
      kind: "joined", target: "channel",
      occurredAt: new Date("2026-09-21T14:30:00.000Z"), payload: { gamertag: "SomePlayer" },
    }, site, dormantAfterMs);
    expect(line).toContain(`[SomePlayer](<${site}/players/SomePlayer>)`);
  });
  it("renders dismantle with the part, and the gate line without one", () => {
    expect(noticeText({ kind: "dismantle", target: "channel", occurredAt: now, payload: { gamertag: "Sasha", part: "wall_base_down" } }, site, dormantAfterMs)).toContain("dismantled wall_base_down at your base");
    expect(noticeText({ kind: "solo_gate", target: "dm", occurredAt: now, payload: { gamertag: "Sasha" } }, site, dormantAfterMs)).toBe(`🔧 [Sasha](<${site}/players/Sasha>) (not a member) built a gate at your base — <t:1788696000:R>`);
  });

  it("renders the nine leadership and vault lines (spec §9.3, §9.4)", () => {
    expect(noticeText({ kind: "leader_removed", target: "channel", occurredAt: now, payload: { old: "Wolfie", new: "Bear1" } }, site, dormantAfterMs))
      .toBe(`👑 [Wolfie](<${site}/players/Wolfie>) is no longer in the Discord. [Bear1](<${site}/players/Bear1>) is now leader.`);
    expect(noticeText({ kind: "succession_claimed", target: "channel", occurredAt: now, payload: { gamertag: "Bear1", leader: "Wolfie" } }, site, dormantAfterMs))
      .toBe(`⏳ [Bear1](<${site}/players/Bear1>) has claimed leadership — [Wolfie](<${site}/players/Wolfie>) has 48h to show up in game`);
    expect(noticeText({ kind: "succession_voided", target: "channel", occurredAt: now, payload: { leader: "Wolfie", claimant: "Bear1" } }, site, dormantAfterMs))
      .toBe(`⏳ [Wolfie](<${site}/players/Wolfie>) showed up in game. The claim by [Bear1](<${site}/players/Bear1>) is void.`);
    expect(noticeText({ kind: "succession_done", target: "channel", occurredAt: now, payload: { gamertag: "Bear1" } }, site, dormantAfterMs))
      .toBe(`👑 [Bear1](<${site}/players/Bear1>) is now leader (succession)`);
    expect(noticeText({ kind: "vote_opened", target: "channel", occurredAt: now, payload: { leader: "Wolfie", nominee: "Bear1", closesAt: "2026-09-08T14:00:00.000Z", link: "https://dayzclanwars.com/clan/vote" } }, site, dormantAfterMs))
      .toBe(`🗳️ Vote opened: replace [Wolfie](<${site}/players/Wolfie>) with [Bear1](<${site}/players/Bear1>). Closes <t:1788876000:F> (<t:1788876000:R>). Vote on the site: [open it](<https://dayzclanwars.com/clan/vote>)`);
    expect(noticeText({ kind: "vote_passed", target: "channel", occurredAt: now, payload: { yes: 6, n: 9, nominee: "Bear1", old: "Wolfie" } }, site, dormantAfterMs))
      .toBe(`🗳️ Vote passed (6/9). [Bear1](<${site}/players/Bear1>) is now leader; [Wolfie](<${site}/players/Wolfie>) stays as officer.`);
    expect(noticeText({ kind: "vote_failed", target: "channel", occurredAt: now, payload: { yes: 3, n: 9, date: "2026-09-22T00:00:00.000Z" } }, site, dormantAfterMs))
      .toBe(`🗳️ Vote failed (3/9). Next vote possible <t:1790035200:F>.`);
    expect(noticeText({ kind: "codes_rotated", target: "channel", occurredAt: now, payload: { gamertag: "Bear1" } }, site, dormantAfterMs))
      .toBe(`🔐 Codes rotated by [Bear1](<${site}/players/Bear1>) — see the vault.`);
    expect(noticeText({ kind: "codes_rotated", target: "dm", occurredAt: now, payload: { clan: "Bears", link: "https://dayzclanwars.com/clan/vault" } }, site, dormantAfterMs))
      .toBe("**Bears** rotated its codes. See the vault: [open it](<https://dayzclanwars.com/clan/vault>)");
    expect(noticeText({ kind: "guest", target: "channel", occurredAt: now, payload: { officer: "Wolfie", user: "123456789012345678" } }, site, dormantAfterMs))
      .toBe("🎟️ [Wolfie](<https://dayzclanwars.com/players/Wolfie>) gave <@123456789012345678> a 24h voice guest pass.");
  });

  it("renders ban_applied's until as a live token, never the raw ISO string ban-tick.ts writes", () => {
    expect(noticeText({ kind: "ban_applied", target: "dm", occurredAt: now, payload: { until: "2026-09-28T14:00:00.000Z", reason: "boost stack" } }, site, dormantAfterMs))
      .toBe("⛔ You are banned from the server until <t:1790604000:F> — boost stack.");
    expect(noticeText({ kind: "ban_applied", target: "dm", occurredAt: now, payload: { until: null, reason: "boost stack" } }, site, dormantAfterMs))
      .toBe("⛔ You are permanently banned from the server — boost stack.");
  });

  it("degrades an unparseable date by dropping the clause rather than rendering \"NaN undefined NaN\", for each of the four tokenised dates", () => {
    // ban_applied cannot simply drop the clause — that would read as the
    // permanent-ban sentence, which is false for a temporary ban — so it
    // names the term without a date instead.
    expect(noticeText({ kind: "ban_applied", target: "dm", occurredAt: now, payload: { until: "not-a-date", reason: "x" } }, site, dormantAfterMs))
      .toBe("⛔ You are banned from the server for a limited time — x.");
    expect(noticeText({ kind: "kicked", target: "dm", occurredAt: now, payload: { clan: "Bears", until: "not-a-date" } }, site, dormantAfterMs))
      .toBe("You were removed from **Bears**.");
    expect(noticeText({ kind: "vote_opened", target: "channel", occurredAt: now, payload: { leader: "Wolfie", nominee: "Bear1", closesAt: "not-a-date", link: "https://x/vote" } }, site, dormantAfterMs))
      .toBe(`🗳️ Vote opened: replace [Wolfie](<${site}/players/Wolfie>) with [Bear1](<${site}/players/Bear1>). Vote on the site: [open it](<https://x/vote>)`);
    expect(noticeText({ kind: "vote_failed", target: "channel", occurredAt: now, payload: { yes: 3, n: 9, date: "not-a-date" } }, site, dormantAfterMs))
      .toBe("🗳️ Vote failed (3/9).");
  });

  it("never renders a smuggled 4-digit vault code, even though the type forbids it", () => {
    const opened = noticeText({ kind: "vote_opened", target: "channel", occurredAt: now, payload: { leader: "Wolfie", nominee: "Bear1", closesAt: "2026-09-08T14:00:00.000Z", link: "https://x/vote", code: "1234" } as never }, site, dormantAfterMs);
    expect(opened).not.toContain("1234");
    const rotated = noticeText({ kind: "codes_rotated", target: "channel", occurredAt: now, payload: { gamertag: "Bear1", code: "1234" } as never }, site, dormantAfterMs);
    expect(rotated).not.toContain("1234");
  });
});

describe("duration", () => {
  it("renders hours and minutes", () => {
    expect(duration(11700)).toBe("3h 15m");
    expect(duration(60)).toBe("0h 1m");
  });
});

describe("achievement", () => {
  const at = new Date("2026-09-11T12:00:00Z");
  const base = { kind: "achievement" as const, occurredAt: at, target: "channel" as const };
  it("names the player as a mention in their clan channel, and with their tag in the public channel", () => {
    const payload = { key: "sniper", name: "Sniper", description: "A kill from 300 m or more", ownerKind: "player", ownerName: "111111111111111111", clanTag: "BEAR" };
    expect(noticeText({ ...base, payload }, site, dormantAfterMs)).toBe("🏆 <@111111111111111111> earned **Sniper** — A kill from 300 m or more.");
    expect(noticeText({ ...base, payload: { ...payload, public: true } }, site, dormantAfterMs)).toBe("🏆 <@111111111111111111> [BEAR] earned **Sniper** — A kill from 300 m or more.");
  });
  it("links the clan when a clan earns an achievement, since the payload carries its tag", () => {
    const payload = { key: "fortress", name: "Fortress", description: "10 defenses", ownerKind: "clan", ownerName: "Bear Company", clanTag: "BEAR", public: true };
    expect(noticeText({ ...base, payload }, site, dormantAfterMs)).toBe(`🏆 **[Bear Company](<${site}/clans/BEAR>)** [BEAR] earned **Fortress** — 10 defenses.`);
  });
});

describe("bounty", () => {
  it("tells a bounty target what they are wanted for and that everyone can see them", () => {
    const text = noticeText({ kind: "bounty_placed", target: "dm", occurredAt: now, payload: { bountyId: 1, reason: "Combat logging", hours: 72 } }, site, dormantAfterMs);
    expect(text).toContain("Combat logging");
    expect(text).toContain("72 h");
    expect(text).toMatch(/map/u);
  });
  it("says an expired bounty is over, and a revoked one was lifted", () => {
    const e = noticeText({ kind: "bounty_expired", target: "dm", occurredAt: now, payload: { bountyId: 1 } }, site, dormantAfterMs);
    const r = noticeText({ kind: "bounty_revoked", target: "dm", occurredAt: now, payload: { bountyId: 1 } }, site, dormantAfterMs);
    expect(e).toMatch(/served|expired/u);
    expect(r).toMatch(/lifted/u);
  });
});
