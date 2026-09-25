import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import type { Database } from "@factions/db";
import { openDb, makeFixture, MON, at, type Fx } from "../fixture.js";
import { PlayerTexts } from "../../src/story/registry.js";
import { weekWindow } from "../../src/weeks.js";
import { peopleForWeek, friendlyFireForWeek, clanBeefsForWeek } from "../../src/story/people.js";

describe("people, friendly fire and beefs", () => {
  let db: Database; let fx: Fx; let sna = 0; let z2 = 0;
  beforeAll(async () => { db = await openDb(); });
  beforeEach(async () => {
    fx = await makeFixture(db);
    sna = await fx.clan({ tag: "SNA" });
    z2 = await fx.clan({ tag: "Z2", name: "Zone 2" });
    for (const [id, tag] of [["gold", "GoldSkull588"], ["cain", "CainObennett"], ["cha", "chaandlr"], ["bub", "Bubba211558"]] as const) await fx.player(id, tag);
    await fx.member(sna, "gold"); await fx.member(sna, "cain"); await fx.member(z2, "cha");
    // Friendly fire inside SNA: scores nothing, shows on the friendly-fire list.
    await fx.kill({ at: at(0, 21, 23), killer: "gold", victim: "cain", weapon: "AUR AX", killerClan: sna, victimClan: sna, friendlyFire: true });
    await fx.kill({ at: at(0, 21, 34), killer: "gold", victim: "cain", weapon: "(MeleeFist)", killerClan: sna, victimClan: sna, friendlyFire: true });
    // Real kills.
    await fx.kill({ at: at(1, 3), killer: "cha", victim: "gold", weapon: "M4-A1", distanceM: 40, killerClan: z2, victimClan: sna });
    await fx.kill({ at: at(1, 4), killer: "cha", victim: "gold", weapon: "M4-A1", distanceM: 12, killerClan: z2, victimClan: sna });
    await fx.kill({ at: at(2, 5), killer: "gold", victim: "bub", weapon: "DMR", distanceM: 711.4, killerClan: sna });
    // A Hub kill and last week's kill score nowhere.
    await fx.kill({ at: at(2, 6), killer: "gold", victim: "cha", weapon: "DMR", killerClan: sna, victimClan: z2, atHub: true });
    await fx.kill({ at: at(-2), killer: "gold", victim: "cha", weapon: "DMR", killerClan: sna, victimClan: z2 });
    // Odd deaths.
    await fx.kill({ at: at(3, 1), killer: null, victim: "bub", cause: "wolf" });
    await fx.kill({ at: at(3, 2), killer: null, victim: "cain", cause: "died" });
  });
  const read = () => ({ serverId: fx.serverId, ...weekWindow(MON), texts: new PlayerTexts() });

  it("counts kills and deaths with scoringKill: no friendly fire, no Hub, no last week", async () => {
    const p = await peopleForWeek(db, read());
    expect(p.topKillers).toEqual([
      { gamertag: "chaandlr", clan: { name: "Zone 2", tag: "Z2" }, value: 2 },
      { gamertag: "GoldSkull588", clan: { name: "SNA", tag: "SNA" }, value: 1 },
    ]);
    expect(p.mostDeaths).toEqual([
      { gamertag: "GoldSkull588", clan: { name: "SNA", tag: "SNA" }, value: 2 },
      { gamertag: "Bubba211558", clan: null, value: 1 },
    ]);
  });

  it("longest shots in whole metres, with the victim", async () => {
    const p = await peopleForWeek(db, read());
    expect(p.longestShots[0]).toEqual({ gamertag: "GoldSkull588", clan: { name: "SNA", tag: "SNA" }, victim: "Bubba211558", metres: 711, weapon: "DMR" });
  });

  it("odd deaths list wolves and the like, not a generic death", async () => {
    const p = await peopleForWeek(db, read());
    expect(p.oddDeaths).toEqual([{ gamertag: "Bubba211558", cause: "wolf", at: at(3, 1).toISOString() }]);
  });

  it("friendly fire pairs per clan, with weapons and first and last time", async () => {
    expect(await friendlyFireForWeek(db, read())).toEqual([{
      clan: { name: "SNA", tag: "SNA" }, killer: "GoldSkull588", victim: "CainObennett", count: 2,
      weapons: ["(MeleeFist)", "AUR AX"], first: at(0, 21, 23).toISOString(), last: at(0, 21, 34).toISOString(),
    }]);
  });

  it("clan beefs count scoring kills between two different clans", async () => {
    expect(await clanBeefsForWeek(db, read())).toEqual([
      { killerClan: { name: "Zone 2", tag: "Z2" }, victimClan: { name: "SNA", tag: "SNA" }, kills: 2 },
    ]);
  });

  it("⚠️ a killer or victim with no players row is never named by their DayZ id (spec §5.2)", async () => {
    await fx.kill({ at: at(4, 1), killer: "ghost-killer-id", victim: "ghost-victim-id", weapon: "DMR" });
    const p = await peopleForWeek(db, read());
    expect(p.topKillers.some((l) => l.gamertag === "an unknown survivor")).toBe(true);
    expect(p.mostDeaths.some((l) => l.gamertag === "an unknown survivor")).toBe(true);
    const json = JSON.stringify(p);
    expect(json).not.toContain("ghost-killer-id");
    expect(json).not.toContain("ghost-victim-id");
  });
});
