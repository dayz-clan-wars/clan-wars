import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import type { Database } from "@factions/db";
import { openDb, makeFixture, MON, PREV_MON, at, type Fx } from "../fixture.js";
import { PlayerTexts } from "../../src/story/registry.js";
import { weekWindow } from "../../src/weeks.js";
import { flagEventsForWeek, memberMovesForWeek, bountiesForWeek, kothForWeek, airdropsForWeek } from "../../src/story/events.js";
import { loadPreviousEpisode } from "../../src/story/previous.js";
import { whenLabel } from "../../src/story/sql.js";

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
      { clan: { name: "SNA", tag: "SNA" }, kind: "dormant", at: at(2, 2, 37).toISOString(), when: whenLabel(at(2, 2, 37)) },
      { clan: { name: "SNA", tag: "SNA" }, kind: "revived", at: at(2, 20, 14).toISOString(), when: whenLabel(at(2, 20, 14)) },
    ]);
    expect(JSON.stringify(out)).not.toContain("OLDNAME");
  });

  it("member moves: joins and leaves this week, and a raider who then joined the clan they raided", async () => {
    const skull = await fx.clan({ tag: "SKULL", name: "Dead Reckoning" });
    const cock = await fx.clan({ tag: "COCK", name: "The Cocks" });
    for (const [id, tag] of [["tide", "TIDEPRIDE113384"], ["ron", "RonaldRaygun552"], ["old", "OldTimer"]] as const) await fx.player(id, tag);
    await fx.raid({ victim: skull, raider: "tide", raiderClan: null, at: at(2, 5, 58), points: 0 });
    await fx.member(skull, "tide", at(2, 23, 36));             // joined the clan he raided that morning
    await fx.member(cock, "ron", at(-5), at(6, 17, 28));        // left this week
    await fx.member(cock, "old", at(-30), at(-8));              // left last week: not this week's news
    await fx.member(skull, "old", at(9));                       // joins next week: not this week's news
    const out = await memberMovesForWeek(db, read());
    expect(out).toEqual([
      { gamertag: "TIDEPRIDE113384", clan: { name: "Dead Reckoning", tag: "SKULL" }, kind: "joined", at: at(2, 23, 36).toISOString(), when: whenLabel(at(2, 23, 36)), raidedThisClanEarlier: true },
      { gamertag: "RonaldRaygun552", clan: { name: "The Cocks", tag: "COCK" }, kind: "left", at: at(6, 17, 28).toISOString(), when: whenLabel(at(6, 17, 28)), raidedThisClanEarlier: false },
    ]);
  });

  it("a join with no earlier raid on that clan is not flagged", async () => {
    const skull = await fx.clan({ tag: "SKULL" });
    await fx.player("n", "NugzyBudz22");
    await fx.member(skull, "n", at(1));
    expect((await memberMovesForWeek(db, read()))[0]?.raidedThisClanEarlier).toBe(false);
  });

  it("a claimed bounty reports the reason, the claimer, hours to claim and the kill distance", async () => {
    await fx.player("xel", "XeliteSniper190"); await fx.player("tox", "TOXIC REAPER680");
    const ev = await fx.kill({ at: at(2, 23, 34), killer: "tox", victim: "xel", distanceM: 3.2 });
    const texts = new PlayerTexts();
    await fx.bounty({ target: "xel", reason: "For funsies", placedAt: at(2, 18, 43), claimedBy: "tox", claimedAt: at(2, 23, 34), claimEventId: ev });
    expect(await bountiesForWeek(db, read(texts))).toEqual([{
      target: "XeliteSniper190", reason: "For funsies", placedAt: at(2, 18, 43).toISOString(), placedWhen: whenLabel(at(2, 18, 43)), status: "claimed",
      claimer: "TOXIC REAPER680", hoursToClaim: 4.9, claimMetres: 3,
    }]);
    expect(texts.entries().find((e) => e.text === "For funsies")!.kinds).toEqual(["bountyReason"]);
  });

  it("KotH results name the winner and top killers", async () => {
    await fx.player("y", "YrJustBad"); await fx.player("c", "CainObennett");
    await fx.koth({ location: "gliniska", slotAt: at(3, 20), top: [
      { dayzId: "y", gamertag: "YrJustBad", kills: 77 }, { dayzId: "c", gamertag: "CainObennett", kills: 27 },
    ] });
    expect(await kothForWeek(db, read())).toEqual([{
      location: "gliniska", at: at(3, 20).toISOString(), when: whenLabel(at(3, 20)), winner: "YrJustBad",
      top: [{ gamertag: "YrJustBad", kills: 77 }, { gamertag: "CainObennett", kills: 27 }],
    }]);
  });

  // Controller ruling (spec §5.2): the bot froze KotH gamertags as
  // coalesce(players.gamertag, killer dayz id), so a frozen name can be a raw DayZ id.
  // Each is named by its CURRENT players row, or UNKNOWN_PLAYER when there is none.
  it("KotH names an unlinked killer 'an unknown survivor', never the frozen DayZ id", async () => {
    await fx.player("c", "CainObennett");
    await fx.koth({ location: "gliniska", slotAt: at(3, 20), top: [
      { dayzId: "ghost-koth-id", gamertag: "ghost-koth-id", kills: 9 }, { dayzId: "c", gamertag: "OldCainName", kills: 4 },
    ] });
    const out = await kothForWeek(db, read());
    expect(out).toEqual([{
      location: "gliniska", at: at(3, 20).toISOString(), when: whenLabel(at(3, 20)), winner: "an unknown survivor",
      top: [{ gamertag: "an unknown survivor", kills: 9 }, { gamertag: "CainObennett", kills: 4 }],
    }]);
    expect(JSON.stringify(out)).not.toContain("ghost-koth-id");
  });

  it("airdrops in the week only", async () => {
    await fx.airdrop({ location: "tarnow", slotAt: at(1, 22) });
    await fx.airdrop({ location: "dolnik", slotAt: at(-1, 22) });
    expect(await airdropsForWeek(db, read())).toEqual([{ location: "tarnow", at: at(1, 22).toISOString(), when: whenLabel(at(1, 22)), state: "ended" }]);
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
      target: "an unknown survivor", reason: "Griefing", placedAt: at(2, 18, 43).toISOString(), placedWhen: whenLabel(at(2, 18, 43)), status: "open",
      claimer: null, hoursToClaim: null, claimMetres: null,
    }]);
    expect(JSON.stringify(out)).not.toContain("no-players-row-id");
  });
});
