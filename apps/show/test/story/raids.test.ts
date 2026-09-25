import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import { sql } from "drizzle-orm";
import type { Database } from "@factions/db";
import { openDb, makeFixture, MON, at, type Fx } from "../fixture.js";
import { PlayerTexts } from "../../src/story/registry.js";
import { raidsForWeek } from "../../src/story/raids.js";

describe("raidsForWeek", () => {
  let db: Database; let fx: Fx; let sna = 0; let z2 = 0;
  beforeAll(async () => { db = await openDb(); });
  beforeEach(async () => {
    fx = await makeFixture(db);
    sna = await fx.clan({ tag: "SNA" });
    z2 = await fx.clan({ tag: "Z2", name: "Zone 2" });
    for (const [id, tag] of [["p-gold", "GoldSkull588"], ["p-cain", "CainObennett"], ["p-cha", "chaandlr"], ["p-kay", "KayGeeFinesseIs"]] as const) await fx.player(id, tag);
    await fx.member(sna, "p-gold"); await fx.member(sna, "p-cain");
    await fx.member(z2, "p-cha"); await fx.member(z2, "p-kay");
  });
  const read = () => raidsForWeek(db, { serverId: fx.serverId, weekStart: MON, texts: new PlayerTexts() });

  it("tags an offline raid, times the first login after it, and a flag never raised again as null", async () => {
    await fx.session({ dayzId: "p-cain", from: at(1, 2, 52), to: at(1, 4) });
    await fx.raid({ victim: sna, raider: "p-cha", raiderClan: z2, at: at(1, 2, 37), points: 200 });
    expect(await read()).toEqual([{
      at: at(1, 2, 37).toISOString(), raider: "chaandlr", raiderClan: { name: "Zone 2", tag: "Z2" },
      victimClan: { name: "SNA", tag: "SNA" }, points: 200, kind: "offline", victimsOnline: 0,
      minutesUntilVictimLogin: 15, reRaisedAfterMinutes: null,
    }]);
  });

  it("tags an online raid and reports the re-raise as when they got back, in minutes", async () => {
    await fx.session({ dayzId: "p-kay", from: at(2, 2), to: at(2, 5) });
    await fx.raid({ victim: z2, raider: "p-cain", raiderClan: sna, at: at(2, 3, 4), points: 100 });
    await fx.defense({ clan: z2, by: "p-cha", flagDownSince: at(2, 3, 4), at: at(2, 11, 42) });
    const [r] = await read();
    expect(r).toMatchObject({ kind: "online", victimsOnline: 1, minutesUntilVictimLogin: null, reRaisedAfterMinutes: 518 });
  });

  it("⚠️ does not count a member who left the victim clan before the raid as online", async () => {
    await db.execute(sql`update membership_history set left_at = ${at(1, 0).toISOString()}::timestamptz where dayz_id = 'p-gold'`);
    await fx.session({ dayzId: "p-gold", from: at(0, 23), to: at(1, 5) });
    await fx.raid({ victim: sna, raider: "p-cha", raiderClan: z2, at: at(1, 2), points: 200 });
    expect((await read())[0]).toMatchObject({ kind: "offline", victimsOnline: 0 });
  });

  it("credits a re-raise to the raid it followed, not to an earlier raid on the same clan", async () => {
    await fx.raid({ victim: sna, raider: "p-cha", raiderClan: z2, at: at(1, 2), points: 200 });
    await fx.raid({ victim: sna, raider: "p-kay", raiderClan: z2, at: at(3, 16), points: 200 });
    await fx.defense({ clan: sna, by: "p-cain", flagDownSince: at(3, 16), at: at(3, 17) });
    const [first, second] = await read();
    expect(first!.reRaisedAfterMinutes).toBeNull();
    expect(second!.reRaisedAfterMinutes).toBe(60);
  });

  it("a solo raider has no clan", async () => {
    await fx.player("p-solo", "TIDEPRIDE113384");
    await fx.raid({ victim: sna, raider: "p-solo", raiderClan: null, at: at(1, 2), points: 0 });
    expect((await read())[0]).toMatchObject({ raider: "TIDEPRIDE113384", raiderClan: null });
  });
});
