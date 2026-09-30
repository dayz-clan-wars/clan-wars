import { describe, it, expect } from "vitest";
import { noticeText, noticeComponents } from "../src/notice-text.js";

const payload = {
  grantId: 12, awardKey: "plate-carrier", label: "Plate Carrier", reason: "Winner, Sept king-of-the-hill",
  placeBy: "2026-09-29T12:00:00.000Z", awardUrl: "https://dayzclanwars.com/awards/12",
};
const n = { kind: "award_granted" as const, target: "dm" as const, occurredAt: new Date("2026-09-22T12:00:00Z"), payload };

describe("award_granted", () => {
  it("names the award, the reason and the deadline", () => {
    const t = noticeText(n, "https://dayzclanwars.com", 7 * 86_400_000);
    expect(t).toContain("Plate Carrier");
    expect(t).toContain("Winner, Sept king-of-the-hill");
    expect(t).toContain("<t:1790683200:F>");
  });

  it("says how long the award runs when the payload carries it", () => {
    expect(noticeText({ ...n, payload: { ...payload, durationDays: 3 } }, "https://x", 1))
      .toContain("every restart for 3 days from the first restart it spawns.");
    expect(noticeText({ ...n, payload: { ...payload, durationDays: 1 } }, "https://x", 1)).toContain("for 1 day from");
  });

  it("keeps the old wording for a notice queued before grants had a length", () => {
    expect(noticeText(n, "https://x", 1)).toContain("every restart until the award runs out.");
  });

  it("drops the deadline clause rather than print a broken date", () => {
    const t = noticeText({ ...n, payload: { ...payload, placeBy: "not a date" } }, "https://x", 1);
    expect(t).not.toMatch(/NaN|undefined|Invalid/u);
  });

  it("carries a Configure your award link button to the grant's page", () => {
    expect(noticeComponents(n)).toEqual([{ type: 1, components: [{ type: 2, style: 5, label: "Configure your award", url: payload.awardUrl }] }]);
  });

  it("carries no button without a URL", () => {
    expect(noticeComponents({ ...n, payload: { ...payload, awardUrl: "" } })).toBeUndefined();
  });

  it("the booster kit button is unchanged", () => {
    expect(noticeComponents({ kind: "booster_kit_unchosen", payload: { kitUrl: "https://x/kit" } }))
      .toEqual([{ type: 1, components: [{ type: 2, style: 5, label: "Choose your kit", url: "https://x/kit" }] }]);
  });
});

describe("award_received and award_given", () => {
  const received = {
    kind: "award_received" as const, target: "dm" as const, occurredAt: new Date("2026-09-30T12:00:00Z"),
    payload: {
      grantId: 12, awardKey: "weapon-kit", label: "Weapon Kit", fromName: "Ron",
      placeBy: "2026-10-07T12:00:00.000Z", remainingMs: 2 * 86_400_000 + 5 * 3_600_000,
      awardUrl: "https://dayzclanwars.com/awards/12",
    },
  };

  it("names the giver, the award, the deadline and the time left", () => {
    const t = noticeText(received, "https://dayzclanwars.com", 1);
    expect(t).toContain("Ron gave you **Weapon Kit**");
    expect(t).toContain("<t:1791374400:F>");
    expect(t).toContain("It has 2 days 5 hours left, and the clock starts once it spawns.");
    expect(t).not.toMatch(/—|NaN|undefined/u);
  });

  it("links to the award page", () => {
    expect(JSON.stringify(noticeComponents(received))).toContain("https://dayzclanwars.com/awards/12");
  });

  it("gives the receipt to the giver", () => {
    const t = noticeText({ ...received, kind: "award_given", payload: { grantId: 12, awardKey: "weapon-kit", label: "Weapon Kit", toName: "Ann" } }, "https://x", 1);
    expect(t).toBe("You gave your **Weapon Kit** to Ann.");
  });
});
