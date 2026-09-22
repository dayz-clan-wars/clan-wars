import { describe, it, expect } from "vitest";
import type { AwardView } from "@factions/roster";
import { awardPageView } from "@/lib/award-view";
import { STATE_COPY, RESULT_COPY } from "@/lib/award-copy";

const base: AwardView = {
  id: 12, awardKey: "plate-carrier", label: "Plate Carrier", reason: "Won", state: "unplaced",
  placeBy: new Date("2026-09-29T12:00:00Z"), liveFrom: null, expiresAt: null,
  picks: {}, spot: null, linked: { gamertag: "Ron" }, challenge: null,
};

describe("awardPageView", () => {
  it("turns every date into a string, so a poll and the first paint agree", () => {
    const v = awardPageView(base, new Date("2026-09-22T13:10:00Z"));
    expect(v.placeBy).toBe("2026-09-29T12:00:00.000Z");
    expect(v.nextRestartAt).toBe("2026-09-22T14:00:00.000Z");
  });

  it("⚠️ carries a grid ref and a map link, never the raw coordinates", () => {
    const v = awardPageView({ ...base, state: "waiting", spot: { x: 1234.5, y: 99.9, z: 5678.25, placedAt: null } }, new Date());
    const json = JSON.stringify(v);
    expect(v.spot?.grid).toBeTruthy();
    expect(json).not.toContain("1234.5");
    expect(json).not.toContain("5678.25");
    expect(json).not.toContain("99.9");
  });
});

describe("award copy", () => {
  it("has a line for every state", () => {
    expect(Object.keys(STATE_COPY).sort()).toEqual(["expired", "lapsed", "live", "revoked", "unplaced", "waiting"]);
  });
  it("has a sentence for every refusal the API can send, and uses no em dashes", () => {
    for (const k of ["not-found", "ended", "bad-slot", "bad-pick", "incomplete", "not-linked", "failed"]) {
      expect(RESULT_COPY[k], k).toBeTruthy();
    }
    expect(JSON.stringify({ STATE_COPY, RESULT_COPY })).not.toContain("—");
  });
});
