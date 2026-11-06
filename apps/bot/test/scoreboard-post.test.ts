import { describe, it, expect } from "vitest";
import type { Scoreboard, ScoreboardRow } from "@factions/roster";
import { EMPTY_SCOREBOARD } from "@factions/copy";
import { MAX_CARDS, isScoreboardPost, scoreboardKey, scoreboardPost } from "../src/scoreboard-post.js";

const SITE = "https://dayzclanwars.com";
const NOW = new Date("2026-11-02T14:05:00Z");
const flags = (t: string) => `${SITE}/flags/${t}.png`;

const row = (over: Partial<ScoreboardRow> = {}): ScoreboardRow => ({
  rank: 1, tag: "Z2", name: "Zone 2", texture: "Flag_Bear", status: "active",
  points: 800, raids: 7, timesRaided: 0, defenses: 0, alpha: true, price: null, ...over,
});
const board = (rows: ScoreboardRow[]): Scoreboard => ({
  season: { number: 3, startedAt: new Date("2026-10-17T00:00:00Z"), weekClosedThrough: null }, rows,
});

describe("scoreboardPost", () => {
  it("gives every clan a card with its flag, linked to its clan page", () => {
    const p = scoreboardPost(board([row(), row({ rank: 2, tag: "COCK", name: "The Cocks 2.0", texture: "Flag_Rooster", points: 600 })]), SITE, flags, NOW);
    expect(p.embeds).toHaveLength(3);
    expect(p.embeds[1]!).toMatchObject({
      title: "#1 · Zone 2 [Z2]",
      url: `${SITE}/clans/Z2`,
      thumbnail: { url: `${SITE}/flags/Flag_Bear.png` },
    });
    expect(p.embeds[1]!.description).toBe("**800 pts** · ⭐ Alpha\n7 raids · raided 0 times · 0 defenses");
    expect(p.embeds[2]!.url).toBe(`${SITE}/clans/COCK`);
  });

  it("gives every card its own url, or Discord folds them into one gallery", () => {
    const p = scoreboardPost(board([row(), row({ tag: "B" }), row({ tag: "C" })]), SITE, flags, NOW);
    expect(new Set(p.embeds.map((e) => e.url)).size).toBe(4);
  });

  it("heads the post with a link to the scoreboard page, and finds it by that link", () => {
    const p = scoreboardPost(board([row()]), SITE, flags, NOW);
    expect(p.content).toBe(`🏆 **[Season 3 scoreboard](<${SITE}/scoreboard>)**`);
    expect(isScoreboardPost(p.content, SITE)).toBe(true);
    expect(isScoreboardPost(`see ${SITE}/scoreboard`, SITE)).toBe(false);
    expect(isScoreboardPost(p.content, "https://elsewhere.example")).toBe(false);
  });

  it("shows a dormant, unranked clan greyed with no rank", () => {
    const p = scoreboardPost(board([row({ rank: null, status: "dormant", alpha: false, points: 0, raids: 1, timesRaided: 1, defenses: 1 })]), SITE, flags, NOW);
    expect(p.embeds[1]!.title).toBe("— · Zone 2 [Z2]");
    expect(p.embeds[1]!.description).toBe("**0 pts** · Dormant · unranked\n1 raid · raided 1 time · 1 defense");
    expect(p.embeds[1]!.color).toBe(0x4f545c);
  });

  it("escapes markdown in player-chosen names", () => {
    const p = scoreboardPost(board([row({ name: "**bold**", tag: "A_B" })]), SITE, flags, NOW);
    expect(p.embeds[1]!.title).toBe("#1 · \\*\\*bold\\*\\* [A\\_B]");
  });

  it("stamps only the last card with the update time", () => {
    const p = scoreboardPost(board([row(), row({ tag: "B" })]), SITE, flags, NOW);
    expect(p.embeds[1]!.timestamp).toBeUndefined();
    expect(p.embeds[2]!).toMatchObject({ footer: { text: "Updated" }, timestamp: NOW.toISOString() });
  });

  it("posts without a thumbnail when there is no flag base url", () => {
    const p = scoreboardPost(board([row()]), SITE, () => null, NOW);
    expect(p.embeds[1]!.thumbnail).toBeUndefined();
  });

  it("caps at nine cards, because the price list takes one of Discord's ten embeds, and points to the site for the rest", () => {
    const rows = Array.from({ length: 13 }, (_, i) => row({ rank: i + 1, tag: `T${i}` }));
    const p = scoreboardPost(board(rows), SITE, flags, NOW);
    expect(MAX_CARDS).toBe(9);
    expect(p.embeds).toHaveLength(10);
    expect(p.content).toContain(`Top 9 of 13. [+4 more on the site](<${SITE}/scoreboard>)`);
  });

  it("uses the site's sentence between seasons", () => {
    const p = scoreboardPost({ season: null, rows: [] }, SITE, flags, NOW);
    expect(p.embeds).toHaveLength(1);
    expect(p.embeds[0]!.description).toBe(EMPTY_SCOREBOARD);
    expect(isScoreboardPost(p.content, SITE)).toBe(true);
  });

  it("says so when a season has no clans yet", () => {
    const p = scoreboardPost(board([]), SITE, flags, NOW);
    expect(p.embeds).toHaveLength(1);
    expect(p.embeds[0]!.description).toBe("No clans yet.");
  });
});


const price = (over: Partial<NonNullable<ScoreboardRow["price"]>> = {}): NonNullable<ScoreboardRow["price"]> =>
  ({ payout: 148, online: false, recentRaids: 9, hitsThisWeek: 1, newUntil: null, ...over });

describe("the raid-price list", () => {
  const priced = board([
    row({ price: price() }),
    row({ rank: 2, tag: "NDF", name: "NDF", price: price({ payout: 296, online: true, recentRaids: 0, hitsThisWeek: 0 }) }),
    row({ rank: 3, tag: "FRESH", name: "Fresh", price: price({ payout: 0, recentRaids: 0, hitsThisWeek: 0, newUntil: new Date("2026-11-08T10:00:00Z") }) }),
    row({ rank: null, tag: "SLEEP", name: "Sleepers", status: "dormant", points: 0, alpha: false, price: null }),
  ]);
  const p = scoreboardPost(priced, SITE, flags, NOW);
  const list = p.embeds[0]!;

  it("is the first embed, titled for what a raid pays", () => {
    expect(list.title).toBe("💰 What a raid pays right now");
    expect(p.embeds).toHaveLength(5);
  });

  it("lists active clans by payout in a code block of tag, price and a trailing 🟢 only, so no line can wrap or drift on a phone", () => {
    const lines = list.description!.split("\n");
    expect(lines.slice(0, 5)).toEqual([
      "```",
      "NDF    296 🟢",
      "Z2     148",
      "FRESH    0",
      "```",
    ]);
  });

  it("spells the reasons out under the block, one plain line per reason, naming the clans", () => {
    const lines = list.description!.split("\n");
    expect(lines.slice(5, 8)).toEqual([
      "🩹 **Raided this week:** Z2 1 time",
      "🔥 **Raiding lately:** Z2 9",
      "🐣 **New:** FRESH counts from 8 Nov",
    ]);
  });

  it("orders each reason line by count, spells the unit once, and leaves out a reason no clan has", () => {
    const desc = scoreboardPost(board([
      row({ tag: "Z2", price: price({ payout: 148, recentRaids: 9, hitsThisWeek: 1 }) }),
      row({ tag: "OUT", price: price({ payout: 34, recentRaids: 0, hitsThisWeek: 3 }) }),
      row({ tag: "COCK", price: price({ payout: 85, recentRaids: 4, hitsThisWeek: 2 }) }),
      row({ tag: "NDF", price: price({ payout: 114, recentRaids: 3, hitsThisWeek: 1 }) }),
    ]), SITE, flags, NOW).embeds[0]!.description!;
    expect(desc).toContain("🩹 **Raided this week:** OUT 3 times, COCK 2, NDF 1, Z2 1");
    expect(desc).toContain("🔥 **Raiding lately:** Z2 9, COCK 4, NDF 3");
    expect(desc).not.toContain("🐣");
  });

  it("escapes markdown in a tag outside the code block, and not inside it", () => {
    const desc = scoreboardPost(board([row({ tag: "A_B", price: price() })]), SITE, flags, NOW).embeds[0]!.description!;
    expect(desc).toContain("```\nA_B  148\n```");
    expect(desc).toContain("**Raided this week:** A\\_B 1 time");
  });

  it("swaps a backtick in a tag so it cannot close the code block early", () => {
    const desc = scoreboardPost(board([row({ tag: "A`B", price: price() })]), SITE, flags, NOW).embeds[0]!.description!;
    expect(desc.split("\n")[1]).toBe("A'B  148");
    expect(desc.match(/```/g)).toHaveLength(2);
  });

  it("names dormant clans on one line", () => {
    expect(list.description).toContain("Can't be raided: SLEEP");
  });

  it("explains the symbols with numbers from rules.ts", () => {
    expect(list.footer!.text).toContain("🔥 raids in the last 14 days push it up; 🩹 being raided in the last 7 days pulls it down");
    expect(list.footer!.text).toContain("🟢");
    expect(list.footer!.text).toContain("×1.5");
    expect(list.footer!.text).toContain("🐣");
  });

  it("gives the list its own url, and no card shares it", () => {
    expect(list.url).toBe(`${SITE}/scoreboard`);
    expect(new Set(p.embeds.map((e) => e.url)).size).toBe(p.embeds.length);
  });

  it("puts 💰 and the payout after the points on a clan's card, and none on a dormant one", () => {
    expect(p.embeds[1]!.description).toBe("**800 pts** · 💰 148 · ⭐ Alpha\n7 raids · raided 0 times · 0 defenses");
    expect(p.embeds[4]!.description).not.toContain("💰");
  });

  it("keeps the heading link the post is found by", () => {
    expect(isScoreboardPost(p.content, SITE)).toBe(true);
  });

  it("stamps the last card, not the list", () => {
    expect(list.timestamp).toBeUndefined();
    expect(p.embeds[4]!.timestamp).toBe(NOW.toISOString());
  });
});

describe("scoreboardKey and prices", () => {
  const base = scoreboardKey(board([row({ price: price() })]));
  it("changes when a payout, the online flag, a reason count or the new-until date changes", () => {
    for (const over of [{ payout: 149 }, { online: true }, { recentRaids: 8 }, { hitsThisWeek: 0 }, { newUntil: new Date("2026-11-08T00:00:00Z") }]) {
      expect(scoreboardKey(board([row({ price: price(over) })]))).not.toBe(base);
    }
    expect(scoreboardKey(board([row({ price: null })]))).not.toBe(base);
  });
  it("does not change when only the clock moves within the same rounded values", () => {
    expect(scoreboardKey(board([row({ price: price() })]))).toBe(base);
    expect(scoreboardPost(board([row({ price: price() })]), SITE, flags, NOW).embeds[0]!.description)
      .toBe(scoreboardPost(board([row({ price: price() })]), SITE, flags, new Date(NOW.getTime() + 3_600_000)).embeds[0]!.description);
  });
});

describe("scoreboardKey", () => {
  it("changes with anything a card prints", () => {
    const base = scoreboardKey(board([row()]));
    for (const over of [{ points: 1 }, { raids: 1 }, { timesRaided: 1 }, { defenses: 1 }, { alpha: false }, { status: "dormant" }, { name: "x" }, { tag: "x" }, { texture: "x" }, { rank: null }] as Partial<ScoreboardRow>[]) {
      expect(scoreboardKey(board([row(over)]))).not.toBe(base);
    }
  });

  it("does not change with the clock", () => {
    expect(scoreboardKey(board([row()]))).toBe(scoreboardKey(board([row()])));
  });
});
