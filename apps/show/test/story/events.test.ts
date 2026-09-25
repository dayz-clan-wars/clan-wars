import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import type { Database } from "@factions/db";
import { openDb, makeFixture, MON, PREV_MON, at, type Fx } from "../fixture.js";
import { PlayerTexts } from "../../src/story/registry.js";
import { weekWindow } from "../../src/weeks.js";
import { flagEventsForWeek, bountiesForWeek, kothForWeek, airdropsForWeek } from "../../src/story/events.js";
import { loadPreviousEpisode } from "../../src/story/previous.js";

describe("events and the previous episode", () => {
  let db: Database; let fx: Fx;
  beforeAll(async () => { db = await openDb(); });
  beforeEach(async () => { fx = await makeFixture(db); });
  const read = (texts = new PlayerTexts()) => ({ serverId: fx.serverId, ...weekWindow(MON), texts });

  it("flag events carry kind, time and the CURRENT name only, and skip renames", async () => {
    const sna = await fx.clan({ tag: "SNA" });
    await fx.factionEvent(sna, "dormant", at(2, 2, 37), { tag: "SNA", name: "SNA" });
    await fx.factionEvent(sna, "revived", at(2, 20, 14), { tag: "SNA", name: "SNA" });
    await fx.factionEvent(sna, "renamed", at(2, 21), { name: "SNA", previousName: "OLDNAME_MUST_NOT_LEAK" });
    const out = await flagEventsForWeek(db, read());
    expect(out).toEqual([
      { clan: { name: "SNA", tag: "SNA" }, kind: "dormant", at: at(2, 2, 37).toISOString() },
      { clan: { name: "SNA", tag: "SNA" }, kind: "revived", at: at(2, 20, 14).toISOString() },
    ]);
    expect(JSON.stringify(out)).not.toContain("OLDNAME");
  });

  it("a claimed bounty reports the reason, the claimer, hours to claim and the kill distance", async () => {
    await fx.player("xel", "XeliteSniper190"); await fx.player("tox", "TOXIC REAPER680");
    const ev = await fx.kill({ at: at(2, 23, 34), killer: "tox", victim: "xel", distanceM: 3.2 });
    const texts = new PlayerTexts();
    await fx.bounty({ target: "xel", reason: "For funsies", placedAt: at(2, 18, 43), claimedBy: "tox", claimedAt: at(2, 23, 34), claimEventId: ev });
    expect(await bountiesForWeek(db, read(texts))).toEqual([{
      target: "XeliteSniper190", reason: "For funsies", placedAt: at(2, 18, 43).toISOString(), status: "claimed",
      claimer: "TOXIC REAPER680", hoursToClaim: 4.9, claimMetres: 3,
    }]);
    expect(texts.entries().find((e) => e.text === "For funsies")!.kinds).toEqual(["bountyReason"]);
  });

  it("KotH results name the winner and top killers", async () => {
    await fx.koth({ location: "gliniska", slotAt: at(3, 20), top: [
      { dayzId: "y", gamertag: "YrJustBad", kills: 77 }, { dayzId: "c", gamertag: "CainObennett", kills: 27 },
    ] });
    expect(await kothForWeek(db, read())).toEqual([{
      location: "gliniska", at: at(3, 20).toISOString(), winner: "YrJustBad",
      top: [{ gamertag: "YrJustBad", kills: 77 }, { gamertag: "CainObennett", kills: 27 }],
    }]);
  });

  it("airdrops in the week only", async () => {
    await fx.airdrop({ location: "tarnow", slotAt: at(1, 22) });
    await fx.airdrop({ location: "dolnik", slotAt: at(-1, 22) });
    expect(await airdropsForWeek(db, read())).toEqual([{ location: "tarnow", at: at(1, 22).toISOString(), state: "ended" }]);
  });

  it("the previous episode is the latest earlier one in the season with a narrative, published or not", async () => {
    const storylines = [{ title: "The House of SNA", players: ["GoldSkull588"], clans: ["SNA"], status: "civil war", openQuestions: ["Who is next?"] }];
    await fx.episode({ weekStart: PREV_MON, episodeNumber: 2, title: "Knives Out", storylines, narrative: "Boris: hi", stage: "rejected" });
    expect(await loadPreviousEpisode(db, fx.seasonId, MON)).toEqual({ title: "Knives Out", storylines });
  });

  it("no previous episode on a season's first week, or when last week never got a script", async () => {
    expect(await loadPreviousEpisode(db, fx.seasonId, MON)).toBeNull();
    await fx.episode({ weekStart: PREV_MON, episodeNumber: 2, title: null, storylines: null, narrative: null, stage: "held" });
    expect(await loadPreviousEpisode(db, fx.seasonId, MON)).toBeNull();
  });

  // Controller ruling: a bounty target with no `players` row is named UNKNOWN_PLAYER,
  // never by their raw DayZ id (spec §5.2 forbids DayZ ids in the context).
  it("a bounty with an unlinked target names them 'an unknown survivor', never their DayZ id", async () => {
    await fx.bounty({ target: "no-players-row-id", reason: "Griefing", placedAt: at(2, 18, 43) });
    const out = await bountiesForWeek(db, read());
    expect(out).toEqual([{
      target: "an unknown survivor", reason: "Griefing", placedAt: at(2, 18, 43).toISOString(), status: "open",
      claimer: null, hoursToClaim: null, claimMetres: null,
    }]);
    expect(JSON.stringify(out)).not.toContain("no-players-row-id");
  });
});
