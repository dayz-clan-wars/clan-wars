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
