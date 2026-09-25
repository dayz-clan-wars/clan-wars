import { describe, it, expect } from "vitest";
import { redactContext } from "../../src/screening/redact.js";
import { PlayerTexts } from "../../src/story/registry.js";
import type { StoryContext } from "../../src/story/types.js";
import type { Verdict } from "../../src/screening/store.js";

const block = (reason = "hate"): Verdict => ({ verdict: "block", source: "llm", reason });

function world() {
  const t = new PlayerTexts();
  const bad = t.clan("Bad Name", "BN");
  const worse = t.clan("Worse", "WRS");
  const context: StoryContext = {
    week: { start: "a", end: "b", season: 1, episode: 3 },
    clans: [
      { ...bad, status: "active", isStaff: false, pitch: t.pitch("join us"), members: 1, weekPoints: 0, weekRaids: 0, timesRaidedThisWeek: 0, seasonPoints: 0, seasonRaids: 0, flagDown: false },
      { ...worse, status: "active", isStaff: false, pitch: null, members: 1, weekPoints: 0, weekRaids: 0, timesRaidedThisWeek: 0, seasonPoints: 0, seasonRaids: 0, flagDown: false },
    ],
    raids: [], flagEvents: [], friendlyFire: [], clanBeefs: [],
    players: { topKillers: [{ gamertag: t.gamertag("EvilTag"), clan: bad, value: 3 }, { gamertag: t.gamertag("Nice"), clan: null, value: 1 }], mostDeaths: [], longestShots: [], oddDeaths: [] },
    bounties: [{ target: t.gamertag("Nice"), reason: t.bountyReason("a slur"), placedAt: "x", status: "open", claimer: null, hoursToClaim: null, claimMetres: null }],
    koth: [], airdrops: [],
    previous: { title: "Last", storylines: [{ title: "EvilTag strikes", players: [t.gamertag("EvilTag")], clans: ["BN"], status: "EvilTag and Nice fought", openQuestions: [] }] },
  };
  return { t, context };
}

describe("redactContext", () => {
  it("aliases a blocked gamertag everywhere, including inside last episode's sentences", () => {
    const { t, context } = world();
    const r = redactContext(context, t.entries(), new Map([["EvilTag", block()]]));
    const json = JSON.stringify(r.context);
    expect(json).not.toContain("EvilTag");
    expect(r.context.players.topKillers[0]!.gamertag).toBe("REDACTED_PLAYER_1");
    expect(r.context.previous!.storylines[0]!.status).toBe("REDACTED_PLAYER_1 and Nice fought");
    expect(r.blocked).toEqual(["EvilTag"]);
  });

  it("matches a blocked name in prose case-insensitively", () => {
    const { t, context } = world();
    context.previous!.storylines[0]!.status = "EVILTAG rampaged, eviltag's gang too";
    const r = redactContext(context, t.entries(), new Map([["EvilTag", block()]]));
    expect(r.context.previous!.storylines[0]!.status).toBe("REDACTED_PLAYER_1 rampaged, REDACTED_PLAYER_1's gang too");
    expect(JSON.stringify(r.context).toLowerCase()).not.toContain("eviltag");
  });

  it("a blocked clan name with a clean tag goes by its tag", () => {
    const { t, context } = world();
    const r = redactContext(context, t.entries(), new Map([["Bad Name", block()]]));
    expect(r.context.clans[0]).toMatchObject({ name: "BN", tag: "BN" });
  });

  it("a clan whose name AND tag are blocked is aliased in both, numbered in order", () => {
    const { t, context } = world();
    const r = redactContext(context, t.entries(), new Map([["BN", block()], ["Bad Name", block()], ["WRS", block()], ["Worse", block()]]));
    expect(r.context.clans.map((c) => [c.name, c.tag])).toEqual([["REDACTED_CLAN_1", "REDACTED_CLAN_1"], ["REDACTED_CLAN_2", "REDACTED_CLAN_2"]]);
  });

  it("a blocked tag with a clean name keeps the name: the name is not what offended", () => {
    const { t, context } = world();
    const r = redactContext(context, t.entries(), new Map([["BN", block()]]));
    expect(r.context.clans[0]).toMatchObject({ name: "Bad Name", tag: "REDACTED_CLAN_1" });
  });

  it("drops a blocked pitch or bounty reason, and reports every redaction", () => {
    const { t, context } = world();
    const r = redactContext(context, t.entries(), new Map([["join us", block("spam")], ["a slur", block()]]));
    expect(r.context.clans[0]!.pitch).toBeNull();
    expect(r.context.bounties[0]!.reason).toBeNull();
    expect(r.report.redactions).toEqual([
      { text: "join us", kinds: ["pitch"], replacement: null, reason: "spam", source: "llm" },
      { text: "a slur", kinds: ["bountyReason"], replacement: null, reason: "hate", source: "llm" },
    ]);
  });

  it("leaves everything alone when nothing is blocked", () => {
    const { t, context } = world();
    const r = redactContext(context, t.entries(), new Map([["EvilTag", { verdict: "allow", source: "llm", reason: null }]]));
    expect(r.context).toEqual(context);
    expect(r.blocked).toEqual([]);
  });
});
