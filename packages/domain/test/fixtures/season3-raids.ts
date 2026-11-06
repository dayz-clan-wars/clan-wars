import type { RaidFact, ValuedClan } from "../../src/raid-value";

/** Production season 3 raids, with the points the independent JS replay computed (Math.round). */
export const CLANS = {
  VOLK: { id: 1, activatedAt: new Date("2026-09-08T23:46:10Z") },
  SKULL: { id: 2, activatedAt: new Date("2026-09-17T21:21:40Z") },
  COCK: { id: 3, activatedAt: new Date("2026-09-15T00:10:06Z") },
  Z2: { id: 4, activatedAt: new Date("2026-09-19T02:04:09Z") },
  WOOKI: { id: 5, activatedAt: new Date("2026-09-26T20:27:03Z") },
  MMBA: { id: 6, activatedAt: new Date("2026-10-20T23:26:35Z") },
  OUT: { id: 7, activatedAt: new Date("2026-10-24T20:34:25Z") },
  NDF: { id: 8, activatedAt: new Date("2026-10-29T22:23:06Z") },
} satisfies Record<string, ValuedClan>;
export type ClanKey = keyof typeof CLANS;

const rows: [string, ClanKey, ClanKey, boolean, number][] = [
  ["10-19T21:50:52", "COCK", "VOLK", false, 75],
  ["10-21T19:34:39", "COCK", "MMBA", true, 0],
  ["10-24T03:10:53", "COCK", "SKULL", false, 75],
  ["10-27T23:07:36", "COCK", "OUT", false, 0],
  ["10-28T00:05:35", "Z2", "WOOKI", true, 150],
  ["10-28T01:05:00", "Z2", "SKULL", false, 58],
  ["10-29T11:26:36", "Z2", "COCK", false, 160],
  ["10-30T01:35:36", "NDF", "OUT", false, 0],
  ["10-30T16:07:13", "Z2", "OUT", false, 0],
  ["10-31T21:45:53", "COCK", "MMBA", true, 150],
  ["11-01T17:00:14", "COCK", "NDF", true, 0],
  ["11-01T18:44:54", "Z2", "OUT", false, 29],
  ["11-01T19:33:08", "Z2", "SKULL", false, 63],
  ["11-01T22:01:47", "NDF", "MMBA", false, 43],
  ["11-01T22:44:59", "Z2", "NDF", false, 0],
  ["11-04T18:44:59", "VOLK", "COCK", true, 293],
  ["11-05T19:43:33", "Z2", "OUT", false, 55],
  ["11-06T01:32:37", "Z2", "NDF", true, 155],
  ["11-06T03:10:07", "NDF", "Z2", false, 290],
];

export const SEASON3 = rows.map(([at, raider, victim, online, points], i) => ({
  fact: { id: i + 1, at: new Date(`2026-${at}Z`), raiderFactionId: CLANS[raider].id, victimFactionId: CLANS[victim].id } satisfies RaidFact,
  raider, victim, online, points,
}));

export const VALUES_AT_NOON = { VOLK: 144, SKULL: 83, COCK: 113, Z2: 198, WOOKI: 100, MMBA: 74, OUT: 45, NDF: 76 } as const;
export const SEASON_TOTALS = { Z2: 670, NDF: 333, COCK: 300, VOLK: 293 } as const;
