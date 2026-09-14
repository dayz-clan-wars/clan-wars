import { describe, it, expect } from "vitest";
import type { AchievementTile, AchievementWall, BoardPage, PlayerProfile, StatScope } from "@factions/roster";
import { achievementsGroup, boardGroup, playerGroup } from "../src/commands/stats.js";
import { ctxWith, input, sourceOf, specOf } from "./command-fakes.js";

const profile = (over: Partial<PlayerProfile> = {}): PlayerProfile => ({
  dayzId: "p1", gamertag: "Ada", linked: true, scope: { kind: "season", number: 3 }, seasons: [3, 2],
  playTimeSeconds: 7200, sessions: 4, lastSeenAt: new Date("2026-09-12T00:00:00Z"),
  pvpKills: 10, pvpDeaths: 5, kd: 2, killedBy: [], killed: [],
  friendlyFireKills: 0, friendlyFireDeaths: 0, raidCredits: 2, upkeepRaises: 1,
  buildPoints: 30, bestStreak: 4, longestKill: { distanceM: 412, weapon: "SVD" },
  clanHistory: [], clan: { tag: "WLF", name: "Wolves", texture: "wolf" }, encounters: [],
  ...over,
});

const page = (over: Partial<BoardPage> = {}): BoardPage => ({
  scope: { kind: "all" }, clans: {}, seasons: [3], kind: "raiders", page: 2, perPage: 50,
  rows: [{ dayzId: "p1", gamertag: "Ada", value: 12 }], hasNext: true, ...over,
});

const tile = (over: Partial<AchievementTile> = {}): AchievementTile => ({
  key: "first_blood", name: "First Blood", description: "First PvP kill", group: "pvp", owner: "player",
  target: 1, unit: "count", earnedAt: null, count: 0, clanTag: null,
  ...over,
});

/** A realistic wall: `earned` derived from `tiles`, the way `wallFor` actually builds one. */
const wall = (over: Partial<AchievementWall> = {}): AchievementWall => {
  const tiles = over.tiles ?? [
    tile({ key: "first_blood", name: "First Blood", earnedAt: new Date("2026-08-01T00:00:00Z"), count: 1 }),
    tile({ key: "veteran", name: "Veteran", target: 100, unit: "hours", count: 40 }),
  ];
  return {
    tiles,
    earned: tiles.filter((t) => t.earnedAt !== null).length,
    closest: over.closest ?? [tiles[1]!],
  };
};

describe("/player", () => {
  it("renders the profile, naming the scope the read resolved to", async () => {
    const ctx = ctxWith({ playerProfile: async () => profile() });
    const reply = await specOf(playerGroup, "player").handler(ctx, input({ gamertag: "Ada" }));
    const j = reply.embeds![0]!.toJSON();
    expect(j.title).toContain("Ada");
    expect(JSON.stringify(j)).toContain("Season 3");
    expect(reply.ephemeral).toBe(true);
  });

  it("passes the scope through instead of resolving it locally", async () => {
    let got: unknown;
    const ctx = ctxWith({ playerProfile: async (_g: string, scope: StatScope) => { got = scope; return profile(); } });
    await specOf(playerGroup, "player").handler(ctx, input({ gamertag: "Ada", scope: "2" }));
    expect(got).toEqual({ kind: "season", number: 2 });
  });

  it("says no such player rather than rendering an empty card", async () => {
    const ctx = ctxWith({ playerProfile: async () => null });
    const reply = await specOf(playerGroup, "player").handler(ctx, input({ gamertag: "Nobody" }));
    expect(reply.embeds).toBeUndefined();
    expect(reply.content).toBe("No player by that name.");
  });

  it("offers gamertags the server has seen, not only linked ones", async () => {
    let scope: string | undefined;
    const ctx = ctxWith({ suggestGamertags: async (_q: string, s: string) => { scope = s; return ["Ada"]; } });
    const choices = await sourceOf(playerGroup, "player", "gamertag")(ctx, { actorDiscordId: "111", value: "ad" });
    expect(scope).toBe("seen");
    expect(choices).toEqual([{ name: "Ada", value: "Ada" }]);
  });

  /**
   * ⚠️ The card renders headline numbers only. `PlayerProfile` also carries
   * `clanHistory` and `encounters` — neither belongs on a compact card, only
   * on the site's own page. Distinctive values in both, forbidden below,
   * so a fixture that left them empty could not pass this vacuously.
   */
  it("renders nothing from clanHistory or encounters", async () => {
    const FORBIDDEN = ["OLDCLAN", "Old Guard", "Zeke", "Yuri", "MP5"];
    const p = profile({
      clanHistory: [{ tag: "OLDCLAN", name: "Old Guard", joinedAt: new Date("2026-01-01T00:00:00Z"), leftAt: new Date("2026-02-01T00:00:00Z") }],
      encounters: [{ at: new Date("2026-08-01T00:00:00Z"), killer: "Zeke", victim: "Yuri", weapon: "MP5", distanceM: 30, friendlyFire: false }],
    });
    const ctx = ctxWith({ playerProfile: async () => p });
    const reply = await specOf(playerGroup, "player").handler(ctx, input({ gamertag: "Ada" }));
    const rendered = JSON.stringify(reply.embeds![0]!.toJSON());
    for (const secret of FORBIDDEN) expect(rendered, `${secret} reached the card`).not.toContain(secret);
  });
});

describe("/board", () => {
  it("reads the public board by default, with kind, scope and page passed through", async () => {
    let got: unknown[] = [];
    const ctx = ctxWith({
      boardPage: async (...a: unknown[]) => { got = a; return page(); },
      clanBoardPage: async () => { throw new Error("must not be called"); },
    });
    const reply = await specOf(boardGroup, "board").handler(ctx, input({ kind: "raiders", scope: "all", page: 2 }));
    expect(got).toEqual(["raiders", { kind: "all" }, 2]);
    expect(JSON.stringify(reply.embeds![0]!.toJSON())).toContain("Ada");
  });

  /** ⚠️ `mine` routes to a different roster export, which is the one that checks membership. */
  it("reads the clan board when mine is true", async () => {
    let called = false;
    const ctx = ctxWith({
      clanBoardPage: async () => { called = true; return page(); },
      boardPage: async () => { throw new Error("must not be called"); },
    });
    await specOf(boardGroup, "board").handler(ctx, input({ kind: "raiders", mine: true }));
    expect(called).toBe(true);
  });

  it("answers a clan-board refusal in the shared words", async () => {
    const ctx = ctxWith({ clanBoardPage: async () => "not-in-clan" });
    const reply = await specOf(boardGroup, "board").handler(ctx, input({ kind: "raiders", mine: true }));
    expect(reply.content).toBe("You are not in a clan.");
  });

  it("numbers rows from the page it is on and says whether another exists", async () => {
    const ctx = ctxWith({ boardPage: async () => page() });
    const reply = await specOf(boardGroup, "board").handler(ctx, input({ kind: "raiders", page: 2 }));
    const j = reply.embeds![0]!.toJSON();
    expect(JSON.stringify(j.fields)).toContain("51.");
    expect(j.footer!.text).toMatch(/More on the site/u);
  });

  /** ⚠️ R7: the resolved scope must be visible on the card — a fumbled `scope:` must not silently return a different season's numbers. */
  it("prints the resolved scope, not whatever was typed", async () => {
    const ctx = ctxWith({ boardPage: async () => page({ scope: { kind: "season", number: 5 } }) });
    const reply = await specOf(boardGroup, "board").handler(ctx, input({ kind: "raiders", scope: "9" }));
    expect(JSON.stringify(reply.embeds![0]!.toJSON())).toContain("Season 5");
  });

  it("says so plainly when the page has no rows, rather than an empty card", async () => {
    const ctx = ctxWith({ boardPage: async () => page({ rows: [] }) });
    const reply = await specOf(boardGroup, "board").handler(ctx, input({ kind: "raiders" }));
    expect(reply.embeds![0]!.toJSON().description).toMatch(/Nothing yet/u);
  });

  it("asks for a board rather than guessing one", async () => {
    const ctx = ctxWith({ boardPage: async () => { throw new Error("must not be called"); } });
    const reply = await specOf(boardGroup, "board").handler(ctx, input({ kind: "nonsense" }));
    expect(reply.content).toMatch(/Pick a board/u);
  });
});

describe("/achievements", () => {
  it("defaults to the caller's own linked gamertag", async () => {
    let asked: unknown;
    const ctx = ctxWith({
      linkStatus: async () => ({ link: { dayzId: "p1", gamertag: "Ada", verifiedAt: new Date() }, challenge: null, ended: null }),
      achievementsFor: async (s: unknown) => { asked = s; return wall(); },
    });
    const reply = await specOf(achievementsGroup, "achievements").handler(ctx, input());
    expect(asked).toEqual({ gamertag: "Ada" });
    expect(reply.embeds![0]!.toJSON().title).toContain("Ada");
  });

  it("renders earned tiles and the closest field", async () => {
    const ctx = ctxWith({ achievementsFor: async () => wall() });
    const reply = await specOf(achievementsGroup, "achievements").handler(ctx, input({ gamertag: "Ada" }));
    const j = reply.embeds![0]!.toJSON();
    expect(j.title).toContain("1 earned");
    expect(JSON.stringify(j.fields)).toContain("First Blood");
    expect(JSON.stringify(j.fields)).toContain("Veteran — 40/100 hours");
  });

  it("reads a clan's wall when clan: is given", async () => {
    let asked: unknown;
    const ctx = ctxWith({ achievementsFor: async (s: unknown) => { asked = s; return wall(); } });
    await specOf(achievementsGroup, "achievements").handler(ctx, input({ clan: "wlf" }));
    expect(asked).toEqual({ clanTag: "wlf" });
  });

  it("says to link first when the caller has no link and named nobody", async () => {
    const ctx = ctxWith({ linkStatus: async () => ({ link: null, challenge: null, ended: null }) });
    const reply = await specOf(achievementsGroup, "achievements").handler(ctx, input());
    expect(reply.content).toMatch(/Link your character first/u);
  });

  it("says no such clan when the wall comes back null", async () => {
    const ctx = ctxWith({ achievementsFor: async () => null });
    const reply = await specOf(achievementsGroup, "achievements").handler(ctx, input({ clan: "zzz" }));
    expect(reply.embeds).toBeUndefined();
    expect(reply.content).toBeTruthy();
  });

  it("says no such player when the wall comes back null for a gamertag, in the shared words", async () => {
    const ctx = ctxWith({ achievementsFor: async () => null });
    const reply = await specOf(achievementsGroup, "achievements").handler(ctx, input({ gamertag: "Nobody" }));
    expect(reply.embeds).toBeUndefined();
    expect(reply.content).toBe("No player by that name.");
  });
});
