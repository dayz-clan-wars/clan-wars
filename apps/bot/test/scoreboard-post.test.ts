import { describe, it, expect } from "vitest";
import type { Scoreboard, ScoreboardRow } from "@factions/roster";
import { EMPTY_SCOREBOARD } from "@factions/copy";
import { MAX_CARDS, isScoreboardPost, scoreboardKey, scoreboardPost } from "../src/scoreboard-post.js";

const SITE = "https://dayzclanwars.com";
const NOW = new Date("2026-11-02T14:05:00Z");
const flags = (t: string) => `${SITE}/flags/${t}.png`;

const row = (over: Partial<ScoreboardRow> = {}): ScoreboardRow => ({
  rank: 1, tag: "Z2", name: "Zone 2", texture: "Flag_Bear", status: "active",
  points: 800, raids: 7, timesRaided: 0, defenses: 0, alpha: true, ...over,
});
const board = (rows: ScoreboardRow[]): Scoreboard => ({
  season: { number: 3, startedAt: new Date("2026-10-17T00:00:00Z"), weekClosedThrough: null }, rows,
});

describe("scoreboardPost", () => {
  it("gives every clan a card with its flag, linked to its clan page", () => {
    const p = scoreboardPost(board([row(), row({ rank: 2, tag: "COCK", name: "The Cocks 2.0", texture: "Flag_Rooster", points: 600 })]), SITE, flags, NOW);
    expect(p.embeds).toHaveLength(2);
    expect(p.embeds[0]!).toMatchObject({
      title: "#1 · Zone 2 [Z2]",
      url: `${SITE}/clans/Z2`,
      thumbnail: { url: `${SITE}/flags/Flag_Bear.png` },
    });
    expect(p.embeds[0]!.description).toBe("**800 pts** · ⭐ Alpha\n7 raids · raided 0 times · 0 defenses");
    expect(p.embeds[1]!.url).toBe(`${SITE}/clans/COCK`);
  });

  it("gives every card its own url, or Discord folds them into one gallery", () => {
    const p = scoreboardPost(board([row(), row({ tag: "B" }), row({ tag: "C" })]), SITE, flags, NOW);
    expect(new Set(p.embeds.map((e) => e.url)).size).toBe(3);
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
    expect(p.embeds[0]!.title).toBe("— · Zone 2 [Z2]");
    expect(p.embeds[0]!.description).toBe("**0 pts** · Dormant · unranked\n1 raid · raided 1 time · 1 defense");
    expect(p.embeds[0]!.color).toBe(0x4f545c);
  });

  it("escapes markdown in player-chosen names", () => {
    const p = scoreboardPost(board([row({ name: "**bold**", tag: "A_B" })]), SITE, flags, NOW);
    expect(p.embeds[0]!.title).toBe("#1 · \\*\\*bold\\*\\* [A\\_B]");
  });

  it("stamps only the last card with the update time", () => {
    const p = scoreboardPost(board([row(), row({ tag: "B" })]), SITE, flags, NOW);
    expect(p.embeds[0]!.timestamp).toBeUndefined();
    expect(p.embeds[1]!).toMatchObject({ footer: { text: "Updated" }, timestamp: NOW.toISOString() });
  });

  it("posts without a thumbnail when there is no flag base url", () => {
    const p = scoreboardPost(board([row()]), SITE, () => null, NOW);
    expect(p.embeds[0]!.thumbnail).toBeUndefined();
  });

  it("caps at Discord's ten cards and points to the site for the rest", () => {
    const rows = Array.from({ length: 13 }, (_, i) => row({ rank: i + 1, tag: `T${i}` }));
    const p = scoreboardPost(board(rows), SITE, flags, NOW);
    expect(p.embeds).toHaveLength(MAX_CARDS);
    expect(p.content).toContain(`Top 10 of 13. [+3 more on the site](<${SITE}/scoreboard>)`);
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
