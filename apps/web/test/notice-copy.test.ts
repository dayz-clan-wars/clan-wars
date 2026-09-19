import { describe, it, expect } from "vitest";
import { CLAN_NOTICE_KINDS } from "@factions/domain";
import { NOTICE_COPY, NOTICE_GROUPS, noticeCopy } from "@/lib/notice-copy";

/**
 * ⚠️ The pin. apps/bot/src/notice-text.ts renders the same kinds for Discord;
 * these are two statements of one fact and they WILL drift. This test catches
 * a kind with no web renderer. It cannot catch a renderer whose wording has
 * diverged in meaning from its Discord twin — read the pair together when
 * either changes (spec §4).
 */
describe("notice copy", () => {
  it("⚠️ covers exactly CLAN_NOTICE_KINDS — no more, no less", () => {
    expect(Object.keys(NOTICE_COPY).sort()).toEqual([...CLAN_NOTICE_KINDS].sort());
  });

  it("gives every kind a group the filter row knows", () => {
    for (const k of CLAN_NOTICE_KINDS) {
      expect(NOTICE_GROUPS, k).toContain(NOTICE_COPY[k].group);
    }
  });

  it("renders every kind from an empty payload without throwing or leaking undefined", () => {
    for (const k of CLAN_NOTICE_KINDS) {
      const c = noticeCopy(k, {});
      expect(c.title.length, k).toBeGreaterThan(0);
      expect(c.kicker.length, k).toBeGreaterThan(0);
      expect(`${c.title} ${c.body}`, k).not.toContain("undefined");
      expect(`${c.title} ${c.body}`, k).not.toContain("null");
      expect(`${c.title} ${c.body}`, k).not.toContain("NaN");
    }
  });

  /**
   * ⚠️ Discord syntax must not reach the page. `<@123>` renders as literal
   * angle brackets, `**bold**` as asterisks, and a bare URL as unclickable
   * text — all three are what the bot's renderer emits by design.
   */
  it("⚠️ emits no Discord syntax: no mentions, no markdown, no bare URLs", () => {
    const payload = { gamertag: "123456789012345678", clan: "Iron Wolves", officer: "987654321098765432", link: "https://dayzclanwars.com/clan" };
    for (const k of CLAN_NOTICE_KINDS) {
      const c = noticeCopy(k, payload);
      const all = `${c.kicker} ${c.title} ${c.body}`;
      expect(all, k).not.toMatch(/<@/u);
      expect(all, k).not.toMatch(/\*\*/u);
      expect(all, k).not.toMatch(/https?:\/\//u);
    }
  });

  /** House style for player-facing copy: no em dashes. */
  it("uses no em dashes", () => {
    for (const k of CLAN_NOTICE_KINDS) {
      const c = noticeCopy(k, { gamertag: "Ada", clan: "Iron Wolves" });
      expect(`${c.title} ${c.body}`, k).not.toContain("—");
    }
  });

  it("names the player when the payload has one", () => {
    expect(noticeCopy("promoted", { gamertag: "Ada" }).body).toContain("Ada");
  });

  /** A raw Discord id in a gamertag slot is a fallback, not a name. */
  it("never prints a raw discord id as if it were a name", () => {
    const c = noticeCopy("promoted", { gamertag: "123456789012345678" });
    expect(c.body).not.toContain("123456789012345678");
  });
});
