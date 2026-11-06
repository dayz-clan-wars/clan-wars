import { describe, it, expect } from "vitest";
import { clanValue, raidPoints, valueReasons, type RaidFact } from "../src/raid-value";
import { CLANS, SEASON3, SEASON_TOTALS, VALUES_AT_NOON, type ClanKey } from "./fixtures/season3-raids";

const DAY = 86_400_000;
const HOUR = 3_600_000;
const NOW = new Date("2026-11-06T12:00:00Z");
const old = { id: 1, activatedAt: new Date(NOW.getTime() - 100 * DAY) };
const fact = (id: number, agoMs: number, raider: number | null, victim: number): RaidFact =>
  ({ id, at: new Date(NOW.getTime() - agoMs), raiderFactionId: raider, victimFactionId: victim });

describe("clanValue", () => {
  it("is 0 for a clan under 7 days old", () => {
    const c = { id: 1, activatedAt: new Date(NOW.getTime() - (6 * DAY + 23 * HOUR)) };
    expect(clanValue(c, [], NOW)).toBe(0);
  });
  it("is 100 for a lone clan", () => expect(clanValue(old, [], NOW)).toBe(100));
  it("adds heat for a raid landed 7d ago", () => expect(clanValue(old, [fact(1, 7 * DAY, 1, 2)], NOW)).toBe(125));
  it("halves-and-recovers after a hit 3.5d ago", () => expect(clanValue(old, [fact(1, 3.5 * DAY, 2, 1)], NOW)).toBe(75));
  it("quarters after two hits right now", () => {
    expect(clanValue(old, [fact(1, 0, 2, 1), fact(2, 0, 3, 1)], new Date(NOW.getTime() + 1))).toBeCloseTo(25, 3);
  });
  it("ignores solo hits", () => expect(clanValue(old, [fact(1, DAY, null, 1)], NOW)).toBe(100));
});

describe("raidPoints", () => {
  it("applies the online multiplier", () => {
    expect(raidPoints(100, true)).toBe(150);
    expect(raidPoints(100, false)).toBe(75);
  });
});

describe("valueReasons", () => {
  it("reports heat, hits and newness", () => {
    const c = { id: 1, activatedAt: new Date(NOW.getTime() - 2 * DAY) };
    const r = valueReasons(c, [fact(1, DAY, 1, 2), fact(2, DAY, 2, 1), fact(3, DAY, null, 1)], NOW);
    expect(r.recentRaids).toBe(1);
    expect(r.hitsThisWeek).toBe(1);
    expect(r.newUntil).toEqual(new Date(c.activatedAt.getTime() + 7 * DAY));
    expect(valueReasons(old, [], NOW).newUntil).toBeNull();
  });
});

describe("season 3 production fixture", () => {
  it("replays each row's points from earlier rows only", () => {
    SEASON3.forEach((row, i) => {
      const facts = SEASON3.slice(0, i).map((r) => r.fact);
      const v = clanValue(CLANS[row.victim], facts, row.fact.at, row.fact.id);
      expect(raidPoints(v, row.online), `row ${row.fact.id}`).toBe(row.points);
    });
  });
  it("gives the same points with every row present (rescore)", () => {
    const all = SEASON3.map((r) => r.fact);
    for (const row of SEASON3) {
      const v = clanValue(CLANS[row.victim], all, row.fact.at, row.fact.id);
      expect(raidPoints(v, row.online), `row ${row.fact.id}`).toBe(row.points);
    }
  });
  it("matches season totals", () => {
    const totals: Record<string, number> = {};
    for (const r of SEASON3) totals[r.raider] = (totals[r.raider] ?? 0) + r.points;
    for (const [k, v] of Object.entries(SEASON_TOTALS)) expect(totals[k]).toBe(v);
  });
  it("matches live values at 2026-11-06T12:00Z", () => {
    const all = SEASON3.map((r) => r.fact);
    for (const k of Object.keys(VALUES_AT_NOON) as ClanKey[]) {
      expect(Math.round(clanValue(CLANS[k], all, NOW)), k).toBe(VALUES_AT_NOON[k]);
    }
  });
});
