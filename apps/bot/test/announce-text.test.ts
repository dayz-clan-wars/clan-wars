import { describe, it, expect } from "vitest";
import { weeklyWipeAnnouncement } from "../src/announce-text.js";

const OLGA = { event: "VehicleCivilianSedan", name: "Olga" };
const WIPE_AT = new Date("2026-09-14T08:00:00Z");

describe("weeklyWipeAnnouncement", () => {
  it("names the vehicle in game and its events.xml event", () => {
    const t = weeklyWipeAnnouncement(OLGA, WIPE_AT);
    expect(t).toContain("Olga");
    expect(t).toContain("VehicleCivilianSedan");
  });

  it("gives the time in UTC, which is what the restarts are in", () => {
    expect(weeklyWipeAnnouncement(OLGA, WIPE_AT)).toContain("08:00 UTC");
  });

  // ⚠️ The one instruction a player can act on. Losing it makes the notice decorative.
  it("tells players to clear their gear out first", () => {
    expect(weeklyWipeAnnouncement(OLGA, WIPE_AT).toLowerCase()).toMatch(/move|take|empty/);
  });

  it("fits in a Discord message", () => {
    expect(weeklyWipeAnnouncement(OLGA, WIPE_AT).length).toBeLessThan(2000);
  });
});
