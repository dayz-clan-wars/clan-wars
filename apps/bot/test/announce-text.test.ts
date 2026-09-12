// ⚠️ Forced off UTC: with TZ=UTC (this machine, and CI) a getHours() implementation
// prints the same string as getUTCHours(), so the assertion below cannot catch the one
// bug it exists for. The production host's timezone is not guaranteed to be UTC.
process.env.TZ = "America/New_York";

import { describe, it, expect } from "vitest";
import { weeklyWipeAnnouncement } from "../src/announce-text.js";

const OLGA = { event: "VehicleCivilianSedan", name: "Olga" };
const WIPE_AT = new Date("2026-09-14T08:00:00Z");

// The usual case: posted a day ahead, Sunday 08:00 for a Monday 08:00 wipe.
const NOW_SUNDAY = new Date("2026-09-13T08:00:01Z");

describe("weeklyWipeAnnouncement", () => {
  it("names the vehicle in game and its events.xml event", () => {
    const t = weeklyWipeAnnouncement(OLGA, WIPE_AT, NOW_SUNDAY);
    expect(t).toContain("Olga");
    expect(t).toContain("VehicleCivilianSedan");
  });

  it("gives the time in UTC, which is what the restarts are in", () => {
    expect(weeklyWipeAnnouncement(OLGA, WIPE_AT, NOW_SUNDAY)).toContain("08:00 UTC");
  });

  it("zero-pads minutes, even single-digit non-zero", () => {
    const t = weeklyWipeAnnouncement(OLGA, new Date("2026-09-14T07:05:00Z"), NOW_SUNDAY);
    expect(t).toContain("07:05 UTC");
  });

  // ⚠️ The one instruction a player can act on. Losing it makes the notice decorative.
  it("tells players to clear their gear out first", () => {
    expect(weeklyWipeAnnouncement(OLGA, WIPE_AT, NOW_SUNDAY).toLowerCase()).toMatch(/move|take|empty/);
  });

  it("fits in a Discord message", () => {
    expect(weeklyWipeAnnouncement(OLGA, WIPE_AT, NOW_SUNDAY).length).toBeLessThan(2000);
  });

  it("says tomorrow when posted the day before, the usual case", () => {
    expect(weeklyWipeAnnouncement(OLGA, WIPE_AT, NOW_SUNDAY)).toContain("tomorrow");
  });

  // ⚠️ Catch-up: the posting window is [wipeAt-24h, wipeAt-1h), which includes Monday
  // 00:00-07:00 UTC. A bot down all Sunday that recovers Monday 06:00 must not say
  // "tomorrow" two hours before the wipe — that actively misinforms players.
  it("says today with an hour estimate when it posts on the wipe day (Monday catch-up)", () => {
    const t = weeklyWipeAnnouncement(OLGA, WIPE_AT, new Date("2026-09-14T06:00:00Z"));
    expect(t).not.toContain("tomorrow");
    expect(t).toContain("today");
    expect(t).toContain("in about 2 hours");
    expect(t).toContain("08:00 UTC");
  });

  it("never prints an estimate of 0 hours", () => {
    const t = weeklyWipeAnnouncement(OLGA, WIPE_AT, new Date("2026-09-14T07:45:00Z"));
    expect(t).not.toContain("0 hours");
    expect(t).toContain("today");
  });
});
