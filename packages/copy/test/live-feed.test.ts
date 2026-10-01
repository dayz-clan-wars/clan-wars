// packages/copy/test/live-feed.test.ts
import { describe, it, expect } from "vitest";
import type { LiveKill, LiveHitRun, LiveStreak, LiveLongRange } from "@factions/domain";
import { killCard, hitCard, streakCard, longRangeCard, who, type Line, type Seg } from "../src/index";

/** Flatten to plain text the way the site prints it, for readable assertions. */
const plain = (l: Line): string => l.map((s: Seg): string => {
  if (typeof s === "string") return s;
  if ("text" in s) return s.text;
  if ("raw" in s) return s.raw;
  if ("bold" in s) return plain(s.bold);
  if ("player" in s) return s.player;
  if ("clan" in s) return s.name ? `${s.name} [${s.clan}]` : s.clan;
  if ("time" in s) return `<${s.style}:${s.time}>`;
  return s.label;
}).join("");

const A = { gamertag: "Alpha", tag: "AAA", texture: "Flag_Wolf" };
const B = { gamertag: "Bravo", tag: null, texture: null };
const kill: LiveKill = {
  occurredAt: "2026-09-08T01:00:00.000Z", killer: A, victim: B, weapon: "KA-74", distanceM: 41.4,
  friendlyFire: false, atHub: false, cause: "pvp", tally: { killerKills: 3, victimDeaths: 1, season: 2 },
  hits: [{ damage: 38.2, bodyPart: "Torso", weapon: "KA-74", distanceM: 41 }],
};

describe("who", () => {
  it("bolds a linked gamertag and adds a linked tag", () => {
    expect(who(A)).toEqual([{ bold: [{ player: "Alpha" }] }, " [", { clan: "AAA" }, "]"]);
    expect(who(B)).toEqual([{ bold: [{ player: "Bravo" }] }]);
  });
});

describe("killCard", () => {
  it("says who killed whom, how, and the season tally", () => {
    const c = killCard(kill);
    expect(plain(c.title)).toBe("Alpha [AAA]");
    expect(c.href).toBe("/players/Alpha");
    expect(c.lines.map(plain)).toEqual(["killed Bravo", "KA-74 · 41 m", "3 kills for Alpha · 1 death for Bravo this season"]);
    expect(c.detail.map(plain)).toEqual(["38 dmg · Torso · KA-74 · 41 m"]);
  });
  it("labels the Hub ahead of friendly fire, and says finished", () => {
    expect(plain(killCard({ ...kill, atHub: true, friendlyFire: true }).title)).toBe("At the Hub — Alpha [AAA]");
    expect(plain(killCard({ ...kill, friendlyFire: true }).title)).toBe("Friendly fire — Alpha [AAA]");
    expect(plain(killCard({ ...kill, friendlyFire: true, cause: "finished" }).lines[0]!)).toBe("finished their own clanmate Bravo");
  });
  it("counts all-time before any season, and drops an empty how line", () => {
    const c = killCard({ ...kill, weapon: null, distanceM: null, tally: { killerKills: 1, victimDeaths: 2, season: null } });
    expect(c.lines.map(plain)).toEqual(["killed Bravo", "1 kill for Alpha · 2 deaths for Bravo all-time"]);
  });
  it("caps the hit run at ten lines", () => {
    const hits = Array.from({ length: 12 }, () => ({ damage: 10, bodyPart: "Head", weapon: null, distanceM: null }));
    const d = killCard({ ...kill, hits }).detail.map(plain);
    expect(d).toHaveLength(11);
    expect(d[10]).toBe("… and 2 more hits");
  });
});

describe("hitCard", () => {
  const h: LiveHitRun = {
    occurredAt: "2026-09-08T01:00:00.000Z", startedAt: "2026-09-08T00:59:00.000Z", attacker: A, victim: B,
    weapon: "M4-A1", friendlyFire: false, totalDamage: 75.6, victimHpAfter: 12.2,
    hits: [{ damage: 40, bodyPart: "Torso", weapon: "M4-A1", distanceM: 80 }, { damage: 35.6, bodyPart: "LeftLeg", weapon: "M4-A1", distanceM: 81 }],
  };
  it("summarises the engagement without repeating the weapon per hit", () => {
    const c = hitCard(h);
    expect(c.lines.map(plain)).toEqual(["hit Bravo 2 times · M4-A1", "76 damage · left them at 12 HP"]);
    expect(c.detail.map(plain)).toEqual(["40 dmg · Torso · 80 m", "36 dmg · LeftLeg · 81 m"]);
  });
  it("says once for one hit", () => {
    expect(plain(hitCard({ ...h, hits: [h.hits[0]!] }).lines[0]!)).toBe("hit Bravo once · M4-A1");
  });
});

describe("streakCard", () => {
  it("names the streak, the victims and how long it has run", () => {
    const s: LiveStreak = { occurredAt: "2026-09-08T01:00:00.000Z", startedAt: "2026-09-08T00:20:00.000Z", killer: A, streak: 3, victims: ["V1", "V2", "V3"] };
    const c = streakCard(s);
    expect(c.lines.map(plain)).toEqual(["🔥 3 kill streak", "last 3: V1, V2, V3", "started 40 minutes ago"]);
  });
});

describe("longRangeCard", () => {
  const l: LiveLongRange = {
    occurredAt: "2026-09-08T01:00:00.000Z", killer: A, victim: B, weapon: "Mosin", distanceM: 412.6, friendlyFire: false,
    personalBest: true, seasonRank: 3, season: 2,
  };
  it("leads with the distance and names both records", () => {
    expect(longRangeCard(l).lines.map(plain)).toEqual(["🎯 413 m", "killed Bravo · Mosin", "Alpha's longest yet · 3rd longest this season"]);
  });
  it("says longest for rank 1 and omits records it does not hold", () => {
    expect(longRangeCard({ ...l, personalBest: false, seasonRank: 1, season: null }).lines.map(plain)[2]).toBe("longest all-time");
    expect(longRangeCard({ ...l, personalBest: false, seasonRank: null }).lines).toHaveLength(2);
  });
});
