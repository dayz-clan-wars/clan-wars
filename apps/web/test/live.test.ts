import { describe, it, expect } from "vitest";
import { parseCursor, toLiveItem, LIVE_TABS } from "../lib/live-items";
import { LIVE_FEEDS, ACHIEVEMENTS } from "@factions/domain";

describe("parseCursor", () => {
  it.each([["12", 12], ["1", 1]])("accepts %s", (v, n) => expect(parseCursor(v)).toBe(n));
  it.each(["abc", "-1", "0", "1.5", "1e309", "9007199254740993", "", " 12"])("ignores %s", (v) => expect(parseCursor(v)).toBeUndefined());
  it("ignores arrays and absence", () => {
    expect(parseCursor(["1", "2"])).toBeUndefined();
    expect(parseCursor(undefined)).toBeUndefined();
    expect(parseCursor(null)).toBeUndefined();
  });
});

describe("LIVE_TABS", () => {
  it("has one tab per feed, in order", () => expect(LIVE_TABS.map((t) => t.feed)).toEqual([...LIVE_FEEDS]));
});

describe("toLiveItem", () => {
  it("marks friendly fire and Hub kills as warn and carries the killer's flag", () => {
    const item = toLiveItem({
      feed: "kills", id: 7, occurredAt: new Date("2026-09-08T01:00:00Z"),
      payload: {
        occurredAt: "2026-09-08T01:00:00.000Z", killer: { gamertag: "A", tag: "AAA", texture: "Flag_Wolf" }, victim: { gamertag: "B", tag: null, texture: null },
        weapon: null, distanceM: null, friendlyFire: true, atHub: false, cause: "pvp", tally: { killerKills: 1, victimDeaths: 1, season: 1 }, hits: [],
      },
    } as never);
    expect(item).toMatchObject({ id: 7, at: "2026-09-08T01:00:00.000Z", tone: "warn", flag: "Flag_Wolf", href: "/players/A" });
  });
  const at = new Date("2026-09-08T01:00:00Z");
  const side = (g: string, texture: string | null = null) => ({ gamertag: g, tag: texture ? "T" : null, texture });
  const kill = (o: object) => ({
    feed: "kills", id: 1, occurredAt: at,
    payload: { occurredAt: at.toISOString(), killer: side("A", "Flag_Wolf"), victim: side("B"), weapon: null, distanceM: null, friendlyFire: false, atHub: false, cause: "pvp", tally: { killerKills: 1, victimDeaths: 1, season: 1 }, hits: [], ...o },
  }) as never;
  it("keeps an ordinary kill plain", () => expect(toLiveItem(kill({})).tone).toBe("plain"));
  it("marks a Hub kill warn", () => expect(toLiveItem(kill({ atHub: true })).tone).toBe("warn"));
  it("marks a friendly-fire hit run warn and carries the attacker's flag", () => {
    const item = toLiveItem({ feed: "hits", id: 2, occurredAt: at, payload: { occurredAt: at.toISOString(), startedAt: at.toISOString(), attacker: side("A", "Flag_Bear"), victim: side("B", "Flag_Rex"), weapon: null, friendlyFire: true, hits: [], totalDamage: null, victimHpAfter: null } } as never);
    expect(item).toMatchObject({ tone: "warn", flag: "Flag_Bear" });
  });
  it("keeps a streak plain and carries the killer's flag", () => {
    const item = toLiveItem({ feed: "streaks", id: 3, occurredAt: at, payload: { occurredAt: at.toISOString(), startedAt: at.toISOString(), killer: side("A", "Flag_Snake"), streak: 5, victims: ["B"] } } as never);
    expect(item).toMatchObject({ tone: "plain", flag: "Flag_Snake" });
  });
  it("carries the killer's flag on a long-range kill", () => {
    const item = toLiveItem({ feed: "long-range", id: 4, occurredAt: at, payload: { occurredAt: at.toISOString(), killer: side("A", "Flag_Crook"), victim: side("B", "Flag_Rex"), weapon: null, distanceM: 600, friendlyFire: false, personalBest: false, seasonRank: null, season: null } } as never);
    expect(item).toMatchObject({ tone: "plain", flag: "Flag_Crook" });
  });
  it("gives a clans row its texture and a title", () => {
    const item = toLiveItem({ feed: "clans", id: 5, occurredAt: at, kind: "founded", payload: { name: "Wolves", tag: "WLF", texture: "Flag_Wolf" } });
    expect(item.flag).toBe("Flag_Wolf");
    expect(item.title).not.toBeNull();
  });
  it("treats an empty clan texture as no flag", () => {
    const item = toLiveItem({ feed: "clans", id: 5, occurredAt: at, kind: "founded", payload: { name: "Wolves", tag: "WLF", texture: "" } });
    expect(item.flag).toBeNull();
  });
  it("gives a war-log row no title and one line", () => {
    const item = toLiveItem({ feed: "war-log", id: 6, occurredAt: at, kind: "defense", payload: { victimClan: "Wolves", victimTag: "WLF", durationSeconds: 3600 } });
    expect(item.title).toBeNull();
    expect(item.lines).toHaveLength(1);
  });
  it("gives one-line feeds no title", () => {
    const item = toLiveItem({ feed: "bans", id: 1, occurredAt: new Date(0), kind: "expired", payload: { gamertag: "A", reason: "conduct", expiresAt: null } });
    expect(item.title).toBeNull();
    expect(item.lines).toHaveLength(1);
  });
  it("gives an achievement its badge", () => {
    const key = ACHIEVEMENTS[0].key;
    const item = toLiveItem({ feed: "achievements", id: 1, occurredAt: new Date(0), payload: { key, name: "N", description: "D", ownerKind: "player", ownerName: null, gamertag: "A", clanTag: null } });
    expect(item.badge).toEqual({ key });
  });
});
