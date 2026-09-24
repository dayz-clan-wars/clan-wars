import { describe, it, expect } from "vitest";
import { scheduledText, reminderText, liveText, resultsText, cancelledText } from "../src/koth-text.js";
import { KOTH_ZONE_RADIUS_M } from "@factions/domain";

const SLOT = new Date("2026-10-03T20:00:00Z");

describe("koth text", () => {
  it("scheduled and reminder name the town, the radius from rules.ts, and the prize", () => {
    for (const t of [scheduledText("Lembork", SLOT), reminderText("Lembork", SLOT)]) {
      expect(t).toContain("LEMBORK");
      expect(t).toContain(`${KOTH_ZONE_RADIUS_M} m`);
      expect(t).toMatch(/Plate Carrier/);
      expect(t).toContain("<t:");
    }
  });
  it("results list the top five, the winner, and a passed-down prize", () => {
    const t = resultsText("Lembork", {
      top: [{ dayzId: "u", gamertag: "Unlinked", kills: 9 }, { dayzId: "l", gamertag: "Linked", kills: 4 }],
      topKiller: { dayzId: "u", gamertag: "Unlinked", kills: 9 },
      winner: { dayzId: "l", gamertag: "Linked", kills: 4 }, droppedNoPosition: 2,
    });
    expect(t).toMatch(/1\. Unlinked — 9/);
    expect(t).toMatch(/Linked/);
    expect(t).toMatch(/not linked/i);
    expect(t).toMatch(/2 kills/);
  });
  // ⚠️ A gamertag is player-controlled text; markdown in it must not restyle the post.
  // Includes brackets/parens too — the house escaper (site-links.ts) covers those; the
  // narrower escaper this used to have did not.
  it("escapes markdown in gamertags", () => {
    const t = resultsText("Lembork", { top: [{ dayzId: "x", gamertag: "**[boss](x)**", kills: 1 }], topKiller: null, winner: null, droppedNoPosition: 0 });
    expect(t).toContain("\\*\\*\\[boss\\]\\(x\\)\\*\\*");
  });
  it("no winner and cancelled read plainly", () => {
    expect(resultsText("Lembork", { top: [], topKiller: null, winner: null, droppedNoPosition: 0 })).toMatch(/nobody/i);
    expect(cancelledText("Lembork", SLOT)).toMatch(/CANCELLED/);
    expect(liveText("Lembork")).toMatch(/LIVE/);
  });
});
