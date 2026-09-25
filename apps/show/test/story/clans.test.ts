import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import type { Database } from "@factions/db";
import { openDb, makeFixture, MON, PREV_MON, at, type Fx } from "../fixture.js";
import { PlayerTexts } from "../../src/story/registry.js";
import { clansForWeek } from "../../src/story/clans.js";
import { seasonForWeek, NoSeasonError } from "../../src/story/season.js";

describe("clansForWeek", () => {
  let db: Database; let fx: Fx;
  beforeAll(async () => { db = await openDb(); });
  beforeEach(async () => { fx = await makeFixture(db); });

  const read = (texts = new PlayerTexts()) =>
    clansForWeek(db, { serverId: fx.serverId, seasonId: fx.seasonId, weekStart: MON, staffTags: ["ADM"], texts });

  it("scores the week from raids.week_start, not from last week's raids", async () => {
    const sna = await fx.clan({ tag: "SNA" });
    const z2 = await fx.clan({ tag: "Z2", name: "Zone 2", pitch: "we raid calendars" });
    await fx.player("p-cha", "chaandlr");
    await fx.raid({ victim: sna, raider: "p-cha", raiderClan: z2, at: at(1, 2, 37), points: 200 });
    await fx.raid({ victim: sna, raider: "p-cha", raiderClan: z2, at: at(-3), points: 100, weekStart: PREV_MON });
    await fx.standing(z2, { points: 300, raids: 2 });
    const clans = await read();
    expect(clans[0]).toMatchObject({ tag: "Z2", name: "Zone 2", weekPoints: 200, weekRaids: 1, seasonPoints: 300, seasonRaids: 2, pitch: "we raid calendars", isStaff: false });
    expect(clans.find((c) => c.tag === "SNA")).toMatchObject({ weekPoints: 0, timesRaidedThisWeek: 1 });
  });

  it("marks staff by the configured tag, never by the clan name", async () => {
    await fx.clan({ tag: "ADM", name: "The Admins" });
    await fx.clan({ tag: "FAKE", name: "ADM" });
    const clans = await read();
    expect(clans.find((c) => c.tag === "ADM")!.isStaff).toBe(true);
    expect(clans.find((c) => c.tag === "FAKE")!.isStaff).toBe(false);
  });

  it("leaves out clans that are not active or dormant", async () => {
    await fx.clan({ tag: "GONE", status: "disbanded" });
    await fx.clan({ tag: "NAP", status: "dormant" });
    expect((await read()).map((c) => c.tag)).toEqual(["NAP"]);
  });

  it("counts full members and registers name, tag and pitch as player text", async () => {
    const z2 = await fx.clan({ tag: "Z2", name: "Zone 2", pitch: "hi" });
    await fx.member(z2, "p1"); await fx.member(z2, "p2"); await fx.member(z2, "p3", at(-10), at(-5));
    const texts = new PlayerTexts();
    const clans = await read(texts);
    expect(clans[0]!.members).toBe(2);
    expect(texts.entries().map((e) => e.text).sort()).toEqual(["Z2", "Zone 2", "hi"]);
  });

  it("finds the season a week belongs to, and refuses a week with none", async () => {
    const s = await seasonForWeek(db, MON);
    expect(s).toMatchObject({ id: fx.seasonId, serverId: fx.serverId, number: 1 });
    await expect(seasonForWeek(db, new Date("2026-08-31T00:00:00Z"))).rejects.toThrow(NoSeasonError);
  });
});
