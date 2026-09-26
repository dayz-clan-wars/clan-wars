import { describe, it, expect } from "vitest";
import { Resvg } from "@resvg/resvg-js";
import { ASSETS } from "../../src/assets.js";
import { buildCardSvg } from "../../src/engine/animation/screenWall.js";
import { buildCards, buildMarqueeItems, buildOutroBoard } from "../../src/cards/cards.js";
import type { ClanWeek, StoryContext } from "../../src/story/types.js";

const clan = (a: Partial<ClanWeek> & { tag: string }): ClanWeek => ({
  name: a.tag,
  status: "active",
  isStaff: false,
  pitch: null,
  members: 1,
  weekPoints: 0,
  weekRaids: 0,
  timesRaidedThisWeek: 0,
  seasonPoints: 0,
  seasonRaids: 0,
  flagDown: false,
  ...a,
});

function ctx(over: Partial<StoryContext> = {}): StoryContext {
  return {
    week: { start: "a", end: "b", season: 1, episode: 3, alpha: null },
    clans: [], raids: [], flagEvents: [], friendlyFire: [], clanBeefs: [],
    players: { topKillers: [], mostDeaths: [], longestShots: [], oddDeaths: [] },
    bounties: [], koth: [], airdrops: [], previous: null,
    ...over,
  };
}

describe("buildCards", () => {
  it("returns exactly 4 cards with the right headers and titles, in order", () => {
    const cards = buildCards(ctx());
    expect(cards).toHaveLength(4);
    for (const c of cards) expect(c.header).toBe("CLAN WARS | S01E03");
    expect(cards.map((c) => c.title)).toEqual(["WEEK STANDINGS", "MOST KILLS", "FRIENDLY FIRE", "LONGEST SHOT"]);
  });

  it("week standings: clans with weekPoints > 0 by points descending, tag as name, at most 5 rows", () => {
    const clans = [
      clan({ tag: "A", weekPoints: 100 }),
      clan({ tag: "B", weekPoints: 300 }),
      clan({ tag: "C", weekPoints: 0 }),
      clan({ tag: "D", weekPoints: 50 }),
      clan({ tag: "E", weekPoints: 20 }),
      clan({ tag: "F", weekPoints: 10 }),
      clan({ tag: "G", weekPoints: 5 }),
    ];
    const [standings] = buildCards(ctx({ clans }));
    expect(standings!.rows).toEqual([
      { name: "B", value: "300 pts" },
      { name: "A", value: "100 pts" },
      { name: "D", value: "50 pts" },
      { name: "E", value: "20 pts" },
      { name: "F", value: "10 pts" },
    ]);
  });

  it("week standings: no raids draws one NO RAIDS row", () => {
    const [standings] = buildCards(ctx({ clans: [clan({ tag: "A", weekPoints: 0 })] }));
    expect(standings!.rows).toEqual([{ name: "NO RAIDS", value: "" }]);
  });

  it("most kills: top 3 players.topKillers, value is the kill count", () => {
    const topKillers = [
      { gamertag: "one", clan: null, value: 9 },
      { gamertag: "two", clan: null, value: 7 },
      { gamertag: "three", clan: null, value: 5 },
      { gamertag: "four", clan: null, value: 3 },
    ];
    const [, mostKills] = buildCards(ctx({ players: { topKillers, mostDeaths: [], longestShots: [], oddDeaths: [] } }));
    expect(mostKills!.rows).toEqual([
      { name: "one", value: "9" },
      { name: "two", value: "7" },
      { name: "three", value: "5" },
    ]);
  });

  it("friendly fire: top 3 killers by summed friendlyFire count across victims", () => {
    const friendlyFire: StoryContext["friendlyFire"] = [
      { clan: { name: "Z", tag: "Z" }, killer: "kilr", victim: "v1", count: 2, weapons: [], first: "a", firstWhen: "a", last: "a", lastWhen: "a" },
      { clan: { name: "Z", tag: "Z" }, killer: "kilr", victim: "v2", count: 3, weapons: [], first: "a", firstWhen: "a", last: "a", lastWhen: "a" },
      { clan: { name: "Z", tag: "Z" }, killer: "other", victim: "v3", count: 1, weapons: [], first: "a", firstWhen: "a", last: "a", lastWhen: "a" },
    ];
    const [, , ff] = buildCards(ctx({ friendlyFire }));
    expect(ff!.rows).toEqual([
      { name: "kilr", value: "5" },
      { name: "other", value: "1" },
    ]);
  });

  it("longest shot: top 3 players.longestShots, value rounded to whole metres", () => {
    const longestShots = [
      { gamertag: "sniper", clan: null, victim: "v", metres: 412.6, weapon: "SVD" },
      { gamertag: "sniper2", clan: null, victim: "v", metres: 300.2, weapon: null },
    ];
    const [, , , shots] = buildCards(ctx({ players: { topKillers: [], mostDeaths: [], longestShots, oddDeaths: [] } }));
    expect(shots!.rows).toEqual([
      { name: "sniper", value: "413m" },
      { name: "sniper2", value: "300m" },
    ]);
  });

  it("a redacted alias draws [REDACTED] on every card", () => {
    const clans = [clan({ tag: "REDACTED_CLAN_1", weekPoints: 10 })];
    const players = {
      topKillers: [{ gamertag: "REDACTED_PLAYER_1", clan: null, value: 4 }],
      mostDeaths: [],
      longestShots: [{ gamertag: "REDACTED_PLAYER_2", clan: null, victim: "v", metres: 100, weapon: null }],
      oddDeaths: [],
    };
    const friendlyFire: StoryContext["friendlyFire"] = [
      { clan: { name: "Z", tag: "Z" }, killer: "REDACTED_PLAYER_3", victim: "v", count: 1, weapons: [], first: "a", firstWhen: "a", last: "a", lastWhen: "a" },
    ];
    const [standings, mostKills, ff, shots] = buildCards(ctx({ clans, players, friendlyFire }));
    expect(standings!.rows[0]!.name).toBe("[REDACTED]");
    expect(mostKills!.rows[0]!.name).toBe("[REDACTED]");
    expect(ff!.rows[0]!.name).toBe("[REDACTED]");
    expect(shots!.rows[0]!.name).toBe("[REDACTED]");
  });

  it("no card string contains an em dash", () => {
    const cards = buildCards(ctx({ clans: [clan({ tag: "A", weekPoints: 10 })] }));
    const json = JSON.stringify(cards);
    expect(json).not.toContain("—");
  });
});

describe("buildMarqueeItems", () => {
  const invite = "discord.gg/TJu4XP25nr";

  it("has the fixed items when there is no data", () => {
    expect(buildMarqueeItems(ctx(), { discordInvite: invite })).toEqual(["DAYZCLANWARS.COM", "discord.gg/TJu4XP25nr"]);
  });

  it("adds top killer, longest shot and alpha, in order, with caps labels and names drawn exactly as given", () => {
    const week: StoryContext["week"] = { start: "a", end: "b", season: 1, episode: 3, alpha: { name: "Zone 2", tag: "Zz2" } };
    const players = {
      topKillers: [{ gamertag: "chaandlr", clan: null, value: 12 }],
      mostDeaths: [],
      longestShots: [{ gamertag: "Fade Fishy69", clan: null, victim: "v", metres: 412.6, weapon: null }],
      oddDeaths: [],
    };
    const items = buildMarqueeItems(ctx({ week, players }), { discordInvite: invite });
    expect(items).toEqual([
      "DAYZCLANWARS.COM",
      "discord.gg/TJu4XP25nr",
      "TOP KILLER: chaandlr (12)",
      "LONGEST SHOT: Fade Fishy69 413m",
      "ALPHA: Zz2",
    ]);
  });

  it("omits top killer, longest shot and alpha independently when their data is missing", () => {
    const week: StoryContext["week"] = { start: "a", end: "b", season: 1, episode: 3, alpha: { name: "Zone 2", tag: "Z2" } };
    const items = buildMarqueeItems(ctx({ week }), { discordInvite: invite });
    expect(items).toEqual(["DAYZCLANWARS.COM", "discord.gg/TJu4XP25nr", "ALPHA: Z2"]);
  });

  it("draws [REDACTED] for a redacted name", () => {
    const week: StoryContext["week"] = { start: "a", end: "b", season: 1, episode: 3, alpha: { name: "x", tag: "REDACTED_CLAN_1" } };
    const players = {
      topKillers: [{ gamertag: "REDACTED_PLAYER_1", clan: null, value: 1 }],
      mostDeaths: [], longestShots: [], oddDeaths: [],
    };
    const items = buildMarqueeItems(ctx({ week, players }), { discordInvite: invite });
    expect(items).toContain("TOP KILLER: [REDACTED] (1)");
    expect(items).toContain("ALPHA: [REDACTED]");
  });

  it("no marquee item contains an em dash", () => {
    const items = buildMarqueeItems(ctx(), { discordInvite: invite });
    expect(items.join("")).not.toContain("—");
  });
});

describe("buildOutroBoard", () => {
  it("headline, top 5 by seasonPoints desc then tag asc, only clans with points > 0", () => {
    const clans = [
      clan({ tag: "A", seasonPoints: 100, seasonRaids: 2 }),
      clan({ tag: "B", seasonPoints: 100, seasonRaids: 5 }),
      clan({ tag: "C", seasonPoints: 0, seasonRaids: 0 }),
      clan({ tag: "D", seasonPoints: 300, seasonRaids: 9 }),
      clan({ tag: "E", seasonPoints: 20, seasonRaids: 1 }),
      clan({ tag: "F", seasonPoints: 10, seasonRaids: 1 }),
      clan({ tag: "G", seasonPoints: 5, seasonRaids: 1 }),
    ];
    const board = buildOutroBoard(ctx({ clans }));
    expect(board.headline).toBe("CLAN WARS | SEASON 1 | AFTER WEEK 3");
    expect(board.rows).toEqual([
      { name: "D", points: 300, raids: 9 },
      { name: "A", points: 100, raids: 2 },
      { name: "B", points: 100, raids: 5 },
      { name: "E", points: 20, raids: 1 },
      { name: "F", points: 10, raids: 1 },
    ]);
  });

  it("draws with zero rows when no clan has season points", () => {
    const board = buildOutroBoard(ctx({ clans: [clan({ tag: "A", seasonPoints: 0 })] }));
    expect(board.rows).toEqual([]);
  });

  it("redacts a clan tag", () => {
    const board = buildOutroBoard(ctx({ clans: [clan({ tag: "REDACTED_CLAN_1", seasonPoints: 10, seasonRaids: 1 })] }));
    expect(board.rows[0]!.name).toBe("[REDACTED]");
  });

  it("no outro board string contains an em dash", () => {
    const board = buildOutroBoard(ctx({ clans: [clan({ tag: "A", seasonPoints: 10 })] }));
    expect(JSON.stringify(board)).not.toContain("—");
  });
});

// Ink test (resvg, as in KOTH): every non-space character of a drawn string must have a glyph in
// the font it is drawn in. A missing glyph (the display font has no U+00B7) draws nothing at all.
function inkOf(ch: string, font: "display" | "gamertag"): number {
  const family = font === "display" ? "Animals are like people" : "Patrick Hand";
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" width="200" height="200"><rect width="200" height="200" fill="#000"/>` +
    `<text x="50" y="120" font-size="100" fill="#fff" font-family="${family}">${ch.replace(/&/g, "&amp;").replace(/</g, "&lt;")}</text></svg>`;
  const { pixels } = new Resvg(svg, { font: { fontFiles: [ASSETS.fonts[font]], loadSystemFonts: false } }).render();
  let ink = 0;
  for (let i = 0; i < pixels.length; i += 4) if (pixels[i]! > 40) ink++;
  return ink;
}

const missingGlyphs = (s: string, font: "display" | "gamertag") =>
  [...new Set(s.replace(/\s/g, ""))].filter((ch) => inkOf(ch, font) === 0);

describe("drawn glyphs", () => {
  it("the card header and outro headline draw every character in the display font", () => {
    const [card] = buildCards(ctx());
    const board = buildOutroBoard(ctx());
    expect(missingGlyphs(card!.header, "display")).toEqual([]);
    expect(missingGlyphs(card!.title, "display")).toEqual([]);
    expect(missingGlyphs(board.headline, "display")).toEqual([]);
  });

  it("the outro row separator (drawn in Patrick Hand) has a glyph", () => {
    expect(missingGlyphs("· pts raids", "gamertag")).toEqual([]);
  });
});

// Pins today's behaviour for empty cards (final review finding 10): an empty stat card draws its
// header, its title and the placeholder row "no data yet"; the standings card never goes empty,
// it draws "NO RAIDS".
describe("empty cards", () => {
  const fonts = { displayFamily: "Animals are like people", gamertagFamily: "Patrick Hand" };
  const texts = (svg: string) => [...svg.matchAll(/<(?:text|tspan)[^>]*>([^<]*)(?=<)/g)].map((m) => m[1]).filter((t) => t);

  it("an empty MOST KILLS card draws the header, the title and the placeholder line", () => {
    const [, mostKills] = buildCards(ctx());
    expect(mostKills!.rows).toEqual([]);
    const svg = buildCardSvg({ ...mostKills!, ...fonts });
    expect(texts(svg)).toEqual(["CLAN WARS | S01E03", "MOST KILLS", "no data yet"]);
  });

  it("the WEEK STANDINGS card with no raids draws NO RAIDS", () => {
    const [standings] = buildCards(ctx());
    const svg = buildCardSvg({ ...standings!, ...fonts });
    expect(texts(svg)).toEqual(["CLAN WARS | S01E03", "WEEK STANDINGS", "NO RAIDS"]);
  });
});
