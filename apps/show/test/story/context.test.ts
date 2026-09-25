import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import type { Database } from "@factions/db";
import { openDb, makeFixture, MON, PREV_MON, at, type Fx } from "../fixture.js";
import { buildStoryContext } from "../../src/story/context.js";

describe("buildStoryContext", () => {
  let db: Database; let fx: Fx;
  beforeAll(async () => { db = await openDb(); });
  beforeEach(async () => { fx = await makeFixture(db); });

  it("builds an empty week: empty lists, S1 E3, no previous", async () => {
    const { context, texts } = await buildStoryContext(db, { weekStart: MON, staffTags: ["ADM"], previous: "db" });
    expect(context.week).toEqual({ start: "2026-09-21T00:00:00.000Z", end: "2026-09-28T00:00:00.000Z", season: 1, episode: 3 });
    expect(context).toMatchObject({ clans: [], raids: [], flagEvents: [], friendlyFire: [], clanBeefs: [], bounties: [], koth: [], airdrops: [], previous: null });
    expect(context.players).toEqual({ topKillers: [], mostDeaths: [], longestShots: [], oddDeaths: [] });
    expect(texts.entries()).toEqual([]);
  });

  it("⚠️ no faction_events payload string, coordinate or id reaches the context", async () => {
    const sna = await fx.clan({ tag: "SNA" });
    await fx.player("dayz-GOLD-ID", "GoldSkull588");
    await fx.member(sna, "dayz-GOLD-ID");
    await fx.factionEvent(sna, "founded", at(0, 1), { tag: "OLDTAG_X", name: "OLDNAME_X", actor: "GoldSkull588", texture: "Flag_Zagorky" });
    await fx.factionEvent(sna, "renamed", at(0, 2), { name: "SNA", previousName: "OLDNAME_X" });
    await fx.kill({ at: at(1), killer: "dayz-GOLD-ID", victim: "v", killerClan: sna });
    await fx.koth({ location: "gliniska", slotAt: at(3, 20), top: [{ dayzId: "dayz-KOTH-GHOST", gamertag: "dayz-KOTH-GHOST", kills: 5 }] });
    const { context } = await buildStoryContext(db, { weekStart: MON, staffTags: [], previous: "db" });
    const json = JSON.stringify(context);
    expect(json).not.toContain("OLDNAME_X");
    expect(json).not.toContain("OLDTAG_X");
    expect(json).not.toContain("Flag_Zagorky");
    expect(json).not.toContain("dayz-GOLD-ID");
    expect(json).not.toContain("dayz-KOTH-GHOST");
    expect(json).not.toContain("disc-");
    expect(json).toContain("GoldSkull588");
  });

  it("carries last episode's storylines and registers their names as player text", async () => {
    const storylines = [{ title: "The House of SNA", players: ["GoldSkull588"], clans: ["SNA"], status: "civil war", openQuestions: ["Next?"] }];
    await fx.episode({ weekStart: PREV_MON, episodeNumber: 2, title: "Knives Out", storylines, narrative: "Boris: hi" });
    const { context, texts } = await buildStoryContext(db, { weekStart: MON, staffTags: [], previous: "db" });
    expect(context.previous).toEqual({ title: "Knives Out", storylines });
    expect(texts.entries().map((e) => e.text).sort()).toEqual(["GoldSkull588", "SNA"]);
  });

  it("carries a previous storyline's names capped, exactly as screening sees them", async () => {
    const long = "L".repeat(40);
    const storylines = [{ title: "t", players: [long], clans: ["C".repeat(20)], status: "s", openQuestions: [] }];
    await fx.episode({ weekStart: PREV_MON, episodeNumber: 2, title: "Knives Out", storylines, narrative: "Boris: hi" });
    const { context, texts } = await buildStoryContext(db, { weekStart: MON, staffTags: [], previous: "db" });
    expect(context.previous!.storylines[0]!.players).toEqual(["L".repeat(32)]);
    expect(context.previous!.storylines[0]!.clans).toEqual(["C".repeat(12)]);
    expect(texts.entries().map((e) => e.text).sort()).toEqual(["C".repeat(12), "L".repeat(32)]);
  });

  it("previous: null skips the lookup (a database without show_episodes yet)", async () => {
    const { context } = await buildStoryContext(db, { weekStart: MON, staffTags: [], previous: null });
    expect(context.previous).toBeNull();
  });
});
