// ⚠️ Forced off UTC: with TZ=UTC (this machine, and CI) a getHours() implementation
// prints the same string as getUTCHours(), so the assertion below cannot catch the one
// bug it exists for. The production host's timezone is not guaranteed to be UTC.
process.env.TZ = "America/New_York";

import { describe, it, expect } from "vitest";
import { weeklyWipeAnnouncement } from "../src/announce-text.js";

const OLGA = { event: "VehicleCivilianSedan", name: "Olga" };
const WIPE_AT = new Date("2026-09-14T08:00:00Z");

describe("weeklyWipeAnnouncement", () => {
  // ⚠️ The in-game name only. The events.xml class is an operator's detail and was
  // deliberately dropped from this player-facing channel on 2026-09-21.
  it("names the vehicle in game, and not its events.xml class", () => {
    const t = weeklyWipeAnnouncement(OLGA, WIPE_AT);
    expect(t).toContain("OLGA");
    expect(t).not.toContain("VehicleCivilianSedan");
  });

  // ⚠️ The one instruction a player can act on. Losing it makes the notice decorative.
  it("tells players to clear their gear out first", () => {
    expect(weeklyWipeAnnouncement(OLGA, WIPE_AT).toLowerCase()).toMatch(/move|take|empty/);
  });

  it("fits in a Discord message", () => {
    expect(weeklyWipeAnnouncement(OLGA, WIPE_AT).length).toBeLessThan(2000);
  });

  it("states the wipe as a token, with no 'tomorrow' arithmetic", () => {
    const wipeAt = new Date("2026-09-21T10:00:00.000Z");
    const text = weeklyWipeAnnouncement({ name: "Olga", event: "VehicleCivilianSedan" }, wipeAt);
    // ⚠️ The relative token alone since 2026-09-21: the notice is two lines, and the
    // absolute date is what pushed it to three.
    expect(text).toContain("<t:1789984800:R>");
    expect(text).not.toContain("tomorrow");
    expect(text).not.toContain("UTC");
  });
});
