import { describe, it, expect } from "vitest";
import { toLiveKill, toLiveStreak } from "../src/live-payload.js";

describe("live payload converters", () => {
  it("turns dates into ISO strings and drops the cursor id", () => {
    const k = toLiveKill({
      eventId: 9, occurredAt: new Date("2026-09-08T01:00:00Z"),
      killer: { gamertag: "A", tag: null, texture: null }, victim: { gamertag: "B", tag: null, texture: null },
      weapon: null, distanceM: null, friendlyFire: false, atHub: false, cause: "pvp",
      tally: { killerKills: 1, victimDeaths: 1, season: null }, hits: [],
    });
    expect(k.occurredAt).toBe("2026-09-08T01:00:00.000Z");
    expect("eventId" in k).toBe(false);
  });
  it("reads a missing streak as 0, as the embed always has", () => {
    const s = toLiveStreak({ eventId: 1, occurredAt: new Date(0), startedAt: new Date(0), killer: { gamertag: "A", tag: null, texture: null }, streak: null, victims: [] });
    expect(s.streak).toBe(0);
  });
});
