import { describe, it, expect } from "vitest";
import { CLAN_NOTICE_KINDS, type NoticeTarget } from "@factions/domain";
import { NOTICE_COPY, NOTICE_GROUPS, noticeCopy } from "@/lib/notice-copy";

const TARGETS: NoticeTarget[] = ["channel", "dm"];

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

  it("renders every kind from an empty payload without throwing or leaking undefined, on both targets", () => {
    for (const k of CLAN_NOTICE_KINDS) {
      for (const target of TARGETS) {
        const c = noticeCopy(k, {}, target);
        expect(c.title.length, `${k}/${target}`).toBeGreaterThan(0);
        expect(c.kicker.length, `${k}/${target}`).toBeGreaterThan(0);
        expect(`${c.title} ${c.body}`, `${k}/${target}`).not.toContain("undefined");
        expect(`${c.title} ${c.body}`, `${k}/${target}`).not.toContain("null");
        expect(`${c.title} ${c.body}`, `${k}/${target}`).not.toContain("NaN");
      }
    }
  });

  /**
   * ⚠️ Discord syntax must not reach the page. `<@123>` renders as literal
   * angle brackets, `**bold**` as asterisks, and a bare URL as unclickable
   * text — all three are what the bot's renderer emits by design.
   */
  it("⚠️ emits no Discord syntax: no mentions, no markdown, no bare URLs, on both targets", () => {
    const payload = {
      gamertag: "123456789012345678", clan: "Iron Wolves", officer: "987654321098765432",
      link: "https://dayzclanwars.com/clan", ownerName: "Iron Wolves", ownerKind: "clan",
    };
    for (const k of CLAN_NOTICE_KINDS) {
      for (const target of TARGETS) {
        const c = noticeCopy(k, payload, target);
        const all = `${c.kicker} ${c.title} ${c.body}`;
        expect(all, `${k}/${target}`).not.toMatch(/<@/u);
        expect(all, `${k}/${target}`).not.toMatch(/\*\*/u);
        expect(all, `${k}/${target}`).not.toMatch(/https?:\/\//u);
      }
    }
  });

  /** House style for player-facing copy: no em dashes. */
  it("uses no em dashes, on both targets", () => {
    for (const k of CLAN_NOTICE_KINDS) {
      for (const target of TARGETS) {
        const c = noticeCopy(k, { gamertag: "Ada", clan: "Iron Wolves" }, target);
        expect(`${c.title} ${c.body}`, `${k}/${target}`).not.toContain("—");
      }
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

  /**
   * ⚠️ `kicked` is written to the clan channel with {gamertag, officer} and to
   * the removed player's DM with {clan, until} (roster-store.ts). Rendering the
   * DM's wording on the channel row would tell every member of the clan they
   * personally were removed.
   */
  it("⚠️ the channel's kicked notice never says the reader was removed", () => {
    const c = noticeCopy("kicked", { gamertag: "Ada", officer: "Bob" }, "channel");
    expect(`${c.title} ${c.body}`).not.toContain("You were removed");
    expect(`${c.title} ${c.body}`).toContain("Ada");
  });

  it("the DM's kicked notice speaks to the removed player directly", () => {
    const c = noticeCopy("kicked", { clan: "Iron Wolves", until: "2026-10-01T00:00:00Z" }, "dm");
    expect(c.title).toContain("You were removed");
  });

  /** IMPORTANT 3: another member's achievement unlock must not read as the viewer's own. */
  it("names the actual unlocker of a clan achievement, not the viewer", () => {
    const c = noticeCopy("achievement", { name: "Centurion", description: "100 kills", ownerKind: "player", gamertag: "Ada" });
    expect(`${c.title} ${c.body}`).toContain("Ada");
  });

  it("names the clan when a clan achievement unlocks", () => {
    const c = noticeCopy("achievement", { name: "Fortress", description: "held for a season", ownerKind: "clan", ownerName: "Iron Wolves" });
    expect(`${c.title} ${c.body}`).toContain("Iron Wolves");
  });

  /** IMPORTANT 5: rule numbers must come from rules.ts, never a hand-typed literal. */
  it("states flag_down's grace period from FLAG_DOWN_MS, not a hand-typed number", () => {
    const c = noticeCopy("flag_down", { gamertag: "Ada" });
    expect(c.body).toContain("24 hours");
  });

  it("states dormant_raided's window from FLAG_DOWN_MS, not a hand-typed number", () => {
    const c = noticeCopy("dormant_raided", {});
    expect(c.body).toContain("24 hours");
  });

  it("states dormant_inactive's window from DORMANT_AFTER_MS, not a hand-typed number", () => {
    const c = noticeCopy("dormant_inactive", {});
    expect(c.body).toContain("7 days");
  });

  /** IMPORTANT 2: a kind absent from CLAN_NOTICE_KINDS (a different software version's data) must not throw. */
  it("⚠️ returns an honest fallback for a kind outside CLAN_NOTICE_KINDS instead of throwing", () => {
    // @ts-expect-error deliberately outside the real union — simulating an old or future kind
    const c = noticeCopy("some_future_kind_the_page_has_never_heard_of", { anything: "goes" });
    expect(c.title.length).toBeGreaterThan(0);
    expect(c.body.length).toBeGreaterThan(0);
  });

  /**
   * ⚠️ The Discord DM for this kind carries a button to /kit. Without a cta the
   * site's copy of the same notice told the reader to go somewhere and gave
   * them no way to get there.
   */
  it("the booster kit notice carries a way to reach the kit", () => {
    const c = noticeCopy("booster_kit_unchosen", {}, "dm");
    expect(c.cta).toEqual({ label: "Choose your kit", href: "/kit" });
  });

  it("points an award notice at that grant's page", () => {
    const c = noticeCopy("award_granted", { grantId: 12, label: "Plate Carrier", reason: "Won the thing" }, "dm");
    expect(c.title).toContain("Plate Carrier");
    expect(c.cta).toEqual({ label: "Configure your award", href: "/awards/12" });
  });

  it("falls back to the awards list when the payload has no grant id", () => {
    expect(noticeCopy("award_granted", {}, "dm").cta).toEqual({ label: "Configure your award", href: "/awards" });
  });
});
