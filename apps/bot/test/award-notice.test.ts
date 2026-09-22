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
