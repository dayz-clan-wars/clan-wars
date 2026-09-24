import { describe, it, expect } from "vitest";
import { scheduledText, reminderText, liveText, resultsText, cancelledText, kothPrize } from "../src/koth-text.js";
import { KOTH_REMINDER_LEAD_MS, KOTH_ZONE_RADIUS_M } from "@factions/domain";
import { awardsCatalogue } from "@factions/domain/awards";

const SLOT = new Date("2026-10-03T20:00:00Z");
const PC = kothPrize("plate-carrier");
const BOARD = {
  top: [{ dayzId: "u", gamertag: "Unlinked", kills: 9 }, { dayzId: "l", gamertag: "Linked", kills: 4 }],
  topKiller: { dayzId: "u", gamertag: "Unlinked", kills: 9 },
  winner: { dayzId: "l", gamertag: "Linked", kills: 4 }, droppedNoPosition: 2,
};

describe("koth text", () => {
  it("scheduled and reminder name the town, the radius from rules.ts, and the prize", () => {
    for (const t of [scheduledText("Lembork", SLOT, PC), reminderText("Lembork", SLOT, PC)]) {
      expect(t).toContain("LEMBORK");
      expect(t).toContain(`${KOTH_ZONE_RADIUS_M} m`);
      expect(t).toMatch(/Plate Carrier/);
      expect(t).toContain("<t:");
    }
  });
  // ⚠️ Two statements of one fact: the lead and the prize length live in rules.ts and
  // the award catalogue, never as literals in the copy.
  it("the reminder's lead and the prize's label and length render from their sources", () => {
    expect(reminderText("Lembork", SLOT, PC)).toContain(`IN ${KOTH_REMINDER_LEAD_MS / 60_000} MINUTES`);
    const def = awardsCatalogue()["plate-carrier"]!;
    const want = def.durationDays === 7 ? "a week" : `${def.durationDays} days`;
    expect(scheduledText("Lembork", SLOT, PC)).toContain(`wins ${want} of the ${def.label}`);
  });
  it("a prize-less event promises none, in every pre-session post", () => {
    for (const t of [scheduledText("Lembork", SLOT, null), reminderText("Lembork", SLOT, null), liveText("Lembork", null)]) {
      expect(t).toMatch(/No prize this time/);
      expect(t).not.toMatch(/Plate Carrier|wins/);
    }
  });
  // ⚠️ A key that left the catalogue is still a promised prize, never "no prize".
  it("a key the catalogue lost still renders as a prize, without a length", () => {
    expect(kothPrize("gone")).toEqual({ label: "gone", durationDays: null });
    expect(kothPrize(null)).toBeNull();
    expect(liveText("Lembork", kothPrize("gone"))).toContain("Most kills wins the gone.");
  });
  it("results list the top five, the winner, and a passed-down prize", () => {
    const t = resultsText("Lembork", BOARD, PC);
    expect(t).toMatch(/1\. Unlinked — 9/);
    expect(t).toMatch(/Plate Carrier goes to \*\*Linked\*\*/);
    expect(t).toMatch(/not linked/i);
    expect(t).toMatch(/2 kills/);
  });
  it("no-prize results crown the top killer and mention no prize or linking", () => {
    const t = resultsText("Lembork", { ...BOARD, winner: BOARD.topKiller }, null);
    expect(t).toMatch(/\*\*Unlinked\*\* is King of the Hill/);
    expect(t).not.toMatch(/Plate Carrier|linked on Discord/);
  });
  it("withheld results name the winner and say an admin has been told", () => {
    const t = resultsText("Lembork", BOARD, PC, true);
    expect(t).toMatch(/\*\*Linked\*\* is King of the Hill/);
    expect(t).toMatch(/could not be granted automatically/);
  });
  // ⚠️ A gamertag is player-controlled text; markdown in it must not restyle the post.
  // Includes brackets/parens too — the house escaper (site-links.ts) covers those; the
  // narrower escaper this used to have did not.
  it("escapes markdown in gamertags", () => {
    const t = resultsText("Lembork", { top: [{ dayzId: "x", gamertag: "**[boss](x)**", kills: 1 }], topKiller: null, winner: null, droppedNoPosition: 0 }, PC);
    expect(t).toContain("\\*\\*\\[boss\\]\\(x\\)\\*\\*");
  });
  it("no winner and cancelled read plainly", () => {
    expect(resultsText("Lembork", { top: [], topKiller: null, winner: null, droppedNoPosition: 0 }, PC)).toMatch(/nobody.*No Plate Carrier/i);
    expect(resultsText("Lembork", { top: [], topKiller: null, winner: null, droppedNoPosition: 0 }, null)).not.toMatch(/No .* this time/);
    expect(cancelledText("Lembork", SLOT)).toMatch(/CANCELLED/);
    expect(liveText("Lembork", PC)).toMatch(/LIVE/);
  });
});
