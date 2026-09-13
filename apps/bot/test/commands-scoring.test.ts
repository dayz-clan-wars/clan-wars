import { describe, it, expect } from "vitest";
import { alphasGroup, scoreboardGroup, seasonsGroup, warlogGroup } from "../src/commands/scoring.js";
import { ctxWith, input, sourceOf, specOf } from "./command-fakes.js";

describe("/scoreboard", () => {
  it("renders the open season's table in the order the roster returned", async () => {
    const ctx = ctxWith({ scoreboard: async () => ({
      season: { number: 3, startedAt: new Date("2026-09-01T00:00:00Z"), weekClosedThrough: null },
      rows: [
        { rank: 1, tag: "WLF", name: "Wolves", texture: "wolf", status: "active", points: 40, raids: 4, timesRaided: 1, defenses: 2, alpha: true },
        { rank: 2, tag: "BR", name: "Bears", texture: "bear", status: "active", points: 10, raids: 1, timesRaided: 0, defenses: 0, alpha: false },
      ],
    }) });
    const reply = await specOf(scoreboardGroup, "scoreboard").handler(ctx, input());
    const value = JSON.stringify(reply.embeds![0]!.toJSON());
    expect(value.indexOf("Wolves")).toBeLessThan(value.indexOf("Bears"));
    expect(value).toContain("Season 3");
    expect(reply.ephemeral).toBe(true);
  });

  it("says there is no season rather than rendering an empty table", async () => {
    const ctx = ctxWith({ scoreboard: async () => ({ season: null, rows: [] }) });
    const reply = await specOf(scoreboardGroup, "scoreboard").handler(ctx, input());
    expect(reply.embeds![0]!.toJSON().description).toMatch(/No season/u);
  });
});

describe("/alphas", () => {
  it("renders each closed week's top three", async () => {
    const ctx = ctxWith({ alphas: async () => ({ season: { number: 3 }, weeks: [
      { weekStart: new Date("2026-09-07T00:00:00Z"), entries: [
        { rank: 1, tag: "WLF", name: "Wolves", texture: "wolf", points: 30 },
        { rank: 2, tag: "BR", name: "Bears", texture: "bear", points: 20 },
      ] },
    ] }) });
    const reply = await specOf(alphasGroup, "alphas").handler(ctx, input());
    expect(JSON.stringify(reply.embeds![0]!.toJSON())).toContain("Wolves");
  });

  it("says no week has closed yet", async () => {
    const ctx = ctxWith({ alphas: async () => ({ season: { number: 3 }, weeks: [] }) });
    const reply = await specOf(alphasGroup, "alphas").handler(ctx, input());
    expect(reply.embeds![0]!.toJSON().description).toMatch(/No week has closed/u);
  });
});

describe("/seasons", () => {
  it("names each closed season's champion", async () => {
    const ctx = ctxWith({ seasons: async () => [{
      number: 2, startedAt: new Date("2026-06-01T00:00:00Z"), endedAt: new Date("2026-08-31T00:00:00Z"),
      champion: { tag: "WLF", name: "Wolves", texture: "wolf", points: 90 }, rows: [],
    }] });
    const reply = await specOf(seasonsGroup, "seasons").handler(ctx, input());
    expect(JSON.stringify(reply.embeds![0]!.toJSON())).toContain("Wolves");
  });

  it("says no season has closed yet", async () => {
    const reply = await specOf(seasonsGroup, "seasons").handler(ctxWith({ seasons: async () => [] }), input());
    expect(reply.embeds![0]!.toJSON().description).toMatch(/No season has closed/u);
  });
});

describe("/warlog", () => {
  it("renders raids and defenses newest first, as the roster ordered them", async () => {
    const ctx = ctxWith({ warLog: async () => [
      { kind: "raid", at: new Date("2026-09-12T10:00:00Z"), raider: { tag: "WLF", name: "Wolves" }, victim: { tag: "BR", name: "Bears", texture: "bear" }, gamertag: "Ada", points: 10, lowers: 1 },
      { kind: "defense", at: new Date("2026-09-11T10:00:00Z"), victim: { tag: "BR", name: "Bears", texture: "bear" }, gamertag: "Bo", durationSeconds: 3600 },
    ] });
    const reply = await specOf(warlogGroup, "warlog").handler(ctx, input());
    const value = JSON.stringify(reply.embeds![0]!.toJSON());
    expect(value.indexOf("Wolves")).toBeLessThan(value.indexOf("under siege"));
  });

  it("passes the clan and kind filters to the roster rather than filtering locally", async () => {
    let got: unknown;
    const ctx = ctxWith({ warLog: async (_limit: number, filter: unknown) => { got = filter; return []; } });
    await specOf(warlogGroup, "warlog").handler(ctx, input({ clan: "WLF", kind: "raid" }));
    expect(got).toEqual({ clanTag: "WLF", kind: "raid" });
  });

  it("says the log is empty rather than rendering nothing", async () => {
    const reply = await specOf(warlogGroup, "warlog").handler(ctxWith({ warLog: async () => [] }), input());
    expect(reply.embeds![0]!.toJSON().description).toMatch(/Nothing yet/u);
  });

  it("offers clans from the directory", async () => {
    const ctx = ctxWith({ directory: async () => ({ clans: [{ tag: "WLF", name: "Wolves", texture: "wolf", memberCount: 4, recruiting: false, alpha: false }] }) });
    const choices = await sourceOf(warlogGroup, "warlog", "clan")(ctx, { actorDiscordId: "111", value: "wol" });
    expect(choices).toEqual([{ name: "Wolves [WLF]", value: "WLF" }]);
  });
});
