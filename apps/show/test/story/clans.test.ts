import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import type { Database } from "@factions/db";
import { openDb, makeFixture, MON, PREV_MON, at, type Fx } from "../fixture.js";
import { PlayerTexts } from "../../src/story/registry.js";
import { clansForWeek } from "../../src/story/clans.js";
import { seasonForWeek, NoSeasonError } from "../../src/story/season.js";
import { weekWindow } from "../../src/weeks.js";

describe("clansForWeek", () => {
  let db: Database; let fx: Fx;
  beforeAll(async () => { db = await openDb(); });
  beforeEach(async () => { fx = await makeFixture(db); });

  const WEEK_END = weekWindow(MON).to;

  const read = (texts = new PlayerTexts()) =>
    clansForWeek(db, { serverId: fx.serverId, seasonId: fx.seasonId, weekStart: MON, weekEnd: WEEK_END, staffTags: ["ADM"], texts });

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

  it("season totals count raids from this week and earlier weeks of the season, never a later week", async () => {
    const sna = await fx.clan({ tag: "SNA" });
    const z2 = await fx.clan({ tag: "Z2" });
    await fx.player("p-cha", "chaandlr");
    await fx.raid({ victim: sna, raider: "p-cha", raiderClan: z2, at: at(-3), points: 50, weekStart: PREV_MON }); // earlier week: counts
    await fx.raid({ victim: sna, raider: "p-cha", raiderClan: z2, at: at(1), points: 100 }); // this week: counts
    await fx.raid({ victim: sna, raider: "p-cha", raiderClan: z2, at: at(8), points: 999, weekStart: at(7) }); // later week: does not count
    const clans = await read();
    expect(clans.find((c) => c.tag === "Z2")).toMatchObject({ seasonPoints: 150, seasonRaids: 2 });
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

  it("shows a clan's status as of week end, not today: dormant after the week ended still reads active", async () => {
    const sna = await fx.clan({ tag: "SNA" }); // activated before the week, per fx.clan's default
    await fx.factionEvent(sna, "dormant", at(10)); // after WEEK_END = at(7)
    const clans = await read();
    expect(clans.find((c) => c.tag === "SNA")).toMatchObject({ status: "active" });
  });

  it("excludes a clan founded (activated) only after week end", async () => {
    await fx.clan({ tag: "NEW", eventAt: at(10) }); // activated after WEEK_END
    expect((await read()).map((c) => c.tag)).toEqual([]);
  });

  it("includes a clan that disbanded after the week ended, under its current name/tag", async () => {
    const z2 = await fx.clan({ tag: "Z2", name: "Zone 2" }); // activated before the week
    await fx.factionEvent(z2, "disbanded", at(10)); // after WEEK_END
    const clans = await read();
    expect(clans.find((c) => c.tag === "Z2")).toMatchObject({ status: "active", name: "Zone 2" });
  });

  it("flagDown is true when the latest in-week raid was revived only after week end", async () => {
    const sna = await fx.clan({ tag: "SNA" });
    await fx.player("p-cha", "chaandlr");
    await fx.raid({ victim: sna, raider: "p-cha", raiderClan: null, at: at(2), points: 100 });
    await fx.factionEvent(sna, "revived", at(10)); // after WEEK_END
    const clans = await read();
    expect(clans.find((c) => c.tag === "SNA")).toMatchObject({ flagDown: true });
  });

  it("flagDown is false when the latest in-week raid was revived before week end", async () => {
    const sna = await fx.clan({ tag: "SNA" });
    await fx.player("p-cha", "chaandlr");
    await fx.raid({ victim: sna, raider: "p-cha", raiderClan: null, at: at(2), points: 100 });
    await fx.factionEvent(sna, "revived", at(3)); // before WEEK_END
    const clans = await read();
    expect(clans.find((c) => c.tag === "SNA")).toMatchObject({ flagDown: false });
  });

  it("counts a member who left only after week end", async () => {
    const z2 = await fx.clan({ tag: "Z2", name: "Zone 2" });
    await fx.member(z2, "p1", at(-10), at(10)); // left after WEEK_END
    const clans = await read();
    expect(clans.find((c) => c.tag === "Z2")).toMatchObject({ members: 1 });
  });

  it("finds the season a week belongs to, and refuses a week with none", async () => {
    const s = await seasonForWeek(db, MON);
    expect(s).toMatchObject({ id: fx.seasonId, serverId: fx.serverId, number: 1 });
    await expect(seasonForWeek(db, new Date("2026-08-31T00:00:00Z"))).rejects.toThrow(NoSeasonError);
  });
});
