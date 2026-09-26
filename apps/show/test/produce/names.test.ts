import { describe, it, expect } from "vitest";
import { collectNames } from "../../src/produce/names.js";
import type { ClanWeek, StoryContext } from "../../src/story/types.js";

const clan = (a: Partial<ClanWeek> & { tag: string; name: string }): ClanWeek => ({
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
    clans: [], raids: [], flagEvents: [], memberMoves: [], friendlyFire: [], clanBeefs: [],
    players: { topKillers: [], mostDeaths: [], raidsByPlayer: [], longestShots: [], oddDeaths: [] },
    bounties: [], koth: [], airdrops: [], previous: null,
    ...over,
  };
}

describe("collectNames", () => {
  it("empty context -> no names, no aliases", () => {
    expect(collectNames(ctx())).toEqual({ names: [], aliases: [] });
  });

  it("includes clan names and clan tags", () => {
    const r = collectNames(ctx({ clans: [clan({ name: "Wolf Pack", tag: "WLF" })] }));
    expect(r.names).toEqual(["Wolf Pack", "WLF"]);
  });

  it("collects from every section that carries a name", () => {
    const wlf = { name: "Wolf Pack", tag: "WLF" };
    const bear = { name: "Bears", tag: "BR" };
    const r = collectNames(
      ctx({
        week: { start: "a", end: "b", season: 1, episode: 3, alpha: { name: "Alpha Clan", tag: "ALP" } },
        raids: [
          {
            at: "", when: "", raider: "raiderGuy", raiderClan: wlf, victimClan: bear, points: 1, kind: "online",
            victimsOnline: 1, minutesUntilVictimLogin: null, reRaisedAfterMinutes: null,
          },
        ],
        flagEvents: [{ clan: { name: "Newbies", tag: "NEW" }, kind: "founded", at: "", when: "" }],
        friendlyFire: [
          { clan: wlf, killer: "ffKiller", victim: "ffVictim", count: 1, weapons: [], first: "", firstWhen: "", last: "", lastWhen: "" },
        ],
        clanBeefs: [{ killerClan: { name: "Beefers", tag: "BF" }, victimClan: bear, kills: 2 }],
        players: {
          topKillers: [{ gamertag: "topK", clan: null, value: 3 }],
          mostDeaths: [{ gamertag: "deadGuy", clan: null, value: 3 }],
          raidsByPlayer: [],
          longestShots: [{ gamertag: "sniper", clan: null, victim: "shotGuy", metres: 400, weapon: null }],
          oddDeaths: [{ gamertag: "oddGuy", cause: "fell", at: "", when: "" }],
        },
        bounties: [
          { target: "wanted", reason: null, placedAt: "", placedWhen: "", status: "claimed", claimer: "hunter", hoursToClaim: 1, claimMetres: 10 },
        ],
        koth: [{ location: "Tisy", at: "", when: "", winner: "kingGuy", top: [{ gamertag: "kothTop", kills: 4 }] }],
        airdrops: [{ location: "NWAF", at: "", when: "", state: "looted" }],
        previous: { title: "t", storylines: [{ title: "s", players: ["oldFeud"], clans: ["OLD"], status: "open", openQuestions: [] }] },
      }),
    );
    for (const n of [
      "Alpha Clan", "ALP", "raiderGuy", "Wolf Pack", "WLF", "Bears", "BR", "Newbies", "NEW", "ffKiller", "ffVictim",
      "Beefers", "BF", "topK", "deadGuy", "sniper", "shotGuy", "oddGuy", "wanted", "hunter", "kingGuy", "kothTop",
      "oldFeud", "OLD",
    ]) {
      expect(r.names).toContain(n);
    }
    // Airdrop locations are places, not names.
    expect(r.names).not.toContain("NWAF");
    expect(r.aliases).toEqual([]);
  });

  it("removes duplicates", () => {
    const r = collectNames(
      ctx({
        clans: [clan({ name: "WLF", tag: "WLF" })],
        players: {
          topKillers: [{ gamertag: "dup", clan: { name: "WLF", tag: "WLF" }, value: 3 }],
          mostDeaths: [{ gamertag: "dup", clan: null, value: 1 }],
          raidsByPlayer: [],
          longestShots: [],
          oddDeaths: [],
        },
      }),
    );
    expect(r.names).toEqual(["WLF", "dup"]);
  });

  it("splits redacted aliases out of names", () => {
    const r = collectNames(
      ctx({
        clans: [clan({ name: "REDACTED_CLAN_1", tag: "REDACTED_CLAN_1" })],
        players: {
          topKillers: [
            { gamertag: "REDACTED_PLAYER_1", clan: null, value: 3 },
            { gamertag: "cleanName", clan: null, value: 2 },
          ],
          mostDeaths: [{ gamertag: "REDACTED_PLAYER_2", clan: null, value: 1 }],
          raidsByPlayer: [],
          longestShots: [],
          oddDeaths: [],
        },
      }),
    );
    expect(r.names).toEqual(["cleanName"]);
    expect(r.aliases).toEqual(["REDACTED_CLAN_1", "REDACTED_PLAYER_1", "REDACTED_PLAYER_2"]);
  });
});
