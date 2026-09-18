import { describe, it, expect } from "vitest";
import type { Boards } from "@factions/roster";
import { leaderboardEmbed, leaderboardKey, boardKindOfEmbedUrl } from "../src/leaderboard-embed.js";

const SITE = "https://dayzclanwars.com";

const empty = (): Boards => ({
  clans: {}, scope: { kind: "season", number: 2 }, seasons: [2, 1],
  raiders: [], killers: [], deaths: [], kd: [], playTime: [], friendlyFire: [], builders: [], streaks: [], longestKills: [],
});

describe("leaderboardEmbed", () => {
  it("titles, links and scopes a board the way the site does", () => {
    const boards = { ...empty(), killers: [{ dayzId: "A", gamertag: "Alpha", value: 7 }] };
    const e = leaderboardEmbed("killers", boards, SITE);
    expect(e.title).toBe("Top killers");
    expect(e.url).toBe(`${SITE}/players/boards/killers`);
    expect(e.description).toContain("Season 2");
    expect(e.description).toContain("Alpha");
    expect(e.description).toContain("7");
  });

  it("ranks rows and shows the clan tag", () => {
    const boards = {
      ...empty(),
      clans: { A: { tag: "BEAR", texture: "Flag_Bear" } },
      killers: [
        { dayzId: "A", gamertag: "Alpha", value: 9 },
        { dayzId: "B", gamertag: "Bravo", value: 4 },
      ],
    };
    // The description opens with the scope heading and a blank line, so the
    // rows start at index 2.
    const lines = leaderboardEmbed("killers", boards, SITE).description!.split("\n");
    expect(lines[2]).toContain("1.");
    expect(lines[2]).toContain("[BEAR]");
    expect(lines[3]).toContain("2.");
    expect(lines[3]).not.toContain("[BEAR]");
  });

  it("formats play time as hours and minutes, not raw seconds", () => {
    const boards = { ...empty(), playTime: [{ dayzId: "A", gamertag: "Alpha", value: 7_380 }] };
    const e = leaderboardEmbed("playTime", boards, SITE);
    expect(e.description).toContain("2h 03m");
    expect(e.description).not.toContain("7380");
  });

  it("carries the unit on a longest kill, and the weapon when the log named one", () => {
    const boards = { ...empty(), longestKills: [{ dayzId: "A", gamertag: "Alpha", value: 412.5, weapon: "DMR" }] };
    const e = leaderboardEmbed("longestKills", boards, SITE);
    expect(e.description).toContain("412.5 m");
    expect(e.description).toContain("DMR");
  });

  it("shows kills and deaths beside a K/D, like the site's panel", () => {
    const boards = { ...empty(), kd: [{ dayzId: "A", gamertag: "Alpha", value: 2.5, kills: 10, deaths: 4 }] };
    expect(leaderboardEmbed("kd", boards, SITE).description).toContain("10 / 4");
  });

  it("says so plainly when a board has nobody on it", () => {
    const e = leaderboardEmbed("builders", empty(), SITE);
    expect(e.description).toContain("Nothing yet.");
  });

  it("⚠️ escapes a gamertag — a player controls it and it lands in markdown", () => {
    const boards = { ...empty(), killers: [{ dayzId: "A", gamertag: "a*b_c", value: 1 }] };
    const e = leaderboardEmbed("killers", boards, SITE);
    expect(e.description).toContain("a\\*b\\_c");
  });
});

describe("leaderboardKey", () => {
  it("is equal for two reads that would render the same message", () => {
    const boards = { ...empty(), killers: [{ dayzId: "A", gamertag: "Alpha", value: 7 }] };
    expect(leaderboardKey("killers", boards)).toBe(leaderboardKey("killers", structuredClone(boards)));
  });

  it("changes when a value, a name, an order or the scope changes", () => {
    const base = { ...empty(), killers: [{ dayzId: "A", gamertag: "Alpha", value: 7 }, { dayzId: "B", gamertag: "Bravo", value: 3 }] };
    const k = leaderboardKey("killers", base);
    expect(leaderboardKey("killers", { ...base, killers: [{ dayzId: "A", gamertag: "Alpha", value: 8 }, { dayzId: "B", gamertag: "Bravo", value: 3 }] })).not.toBe(k);
    expect(leaderboardKey("killers", { ...base, killers: [{ dayzId: "A", gamertag: "Renamed", value: 7 }, { dayzId: "B", gamertag: "Bravo", value: 3 }] })).not.toBe(k);
    expect(leaderboardKey("killers", { ...base, killers: [base.killers[1]!, base.killers[0]!] })).not.toBe(k);
    expect(leaderboardKey("killers", { ...base, scope: { kind: "all" } })).not.toBe(k);
  });

  it("⚠️ changes when only a clan tag changes — the row renders it, so the message must be redrawn", () => {
    const base = { ...empty(), killers: [{ dayzId: "A", gamertag: "Alpha", value: 7 }] };
    const renamed = { ...base, clans: { A: { tag: "WOLF", texture: "Flag_Wolf" } } };
    expect(leaderboardKey("killers", renamed)).not.toBe(leaderboardKey("killers", base));
  });

  it("does not change when a DIFFERENT board changes", () => {
    const base = { ...empty(), killers: [{ dayzId: "A", gamertag: "Alpha", value: 7 }] };
    const other = { ...base, builders: [{ dayzId: "B", gamertag: "Bravo", value: 5 }] };
    expect(leaderboardKey("killers", other)).toBe(leaderboardKey("killers", base));
  });
});

describe("boardKindOfEmbedUrl", () => {
  it("reads a board back off its own embed url", () => {
    expect(boardKindOfEmbedUrl(`${SITE}/players/boards/play-time`, SITE)).toBe("playTime");
    expect(boardKindOfEmbedUrl(`${SITE}/players/boards/friendly-fire`, SITE)).toBe("friendlyFire");
  });

  it("refuses anything that is not one of our board links", () => {
    expect(boardKindOfEmbedUrl(undefined, SITE)).toBeNull();
    expect(boardKindOfEmbedUrl(`${SITE}/players/boards/nonsense`, SITE)).toBeNull();
    expect(boardKindOfEmbedUrl(`${SITE}/clans`, SITE)).toBeNull();
    // ⚠️ A different origin: someone else's link that happens to end in a slug
    // we know must not be mistaken for our own standing message.
    expect(boardKindOfEmbedUrl("https://evil.example/players/boards/killers", SITE)).toBeNull();
  });
});
