import { describe, expect, it } from "vitest";
import {
  loadAwards, isAwardPick, picksComplete, awardState, isOpenAward, awardClock, inAwardFile, type AwardTimes,
} from "../src/awards";
import { AWARD_REMOVAL_LEAD_MS } from "../src/rules";
import raw from "../assets/awards.json";

const GOOD = {
  "plate-carrier": {
    label: "Plate Carrier",
    durationDays: 7,
    slots: {
      vest: { label: "Vest", items: [{ className: "PlateCarrierVest_Black", label: "Plate Carrier (Black)", image: "items/PlateCarrierVest_Black.webp" }] },
      holster: { label: "Holster", items: [{ className: "PlateCarrierHolster_Black", label: "Plate Carrier Holster (Black)" }] },
    },
  },
};
const clone = () => JSON.parse(JSON.stringify(GOOD));

describe("loadAwards", () => {
  it("accepts a well-formed catalogue and keys each definition by its own key", () => {
    const a = loadAwards(GOOD);
    expect(a["plate-carrier"]!.key).toBe("plate-carrier");
    expect(Object.keys(a["plate-carrier"]!.slots)).toEqual(["vest", "holster"]);
  });

  it("the committed catalogue is valid, and the plate carrier has six of each piece", () => {
    const pc = loadAwards(raw)["plate-carrier"]!;
    expect(pc.durationDays).toBe(7);
    for (const slot of ["vest", "pouches", "holster"]) expect(pc.slots[slot]!.items).toHaveLength(6);
  });

  it.each([
    ["an award key that is not kebab-case", (j: any) => { j["Plate_Carrier"] = j["plate-carrier"]; delete j["plate-carrier"]; }, /Plate_Carrier/],
    ["a non-integer duration", (j: any) => { j["plate-carrier"].durationDays = 1.5; }, /durationDays/],
    ["a zero duration", (j: any) => { j["plate-carrier"].durationDays = 0; }, /durationDays/],
    ["an award with no slots", (j: any) => { j["plate-carrier"].slots = {}; }, /no slots/],
    ["a slot with no items", (j: any) => { j["plate-carrier"].slots.vest.items = []; }, /vest/],
    ["a duplicate class name in a slot", (j: any) => { j["plate-carrier"].slots.vest.items.push({ className: "PlateCarrierVest_Black", label: "Other" }); }, /PlateCarrierVest_Black/],
    ["a duplicate label in a slot", (j: any) => { j["plate-carrier"].slots.vest.items.push({ className: "PlateCarrierVest", label: "Plate Carrier (Black)" }); }, /label/],
    ["an image path not named after the class", (j: any) => { j["plate-carrier"].slots.vest.items[0].image = "items/Other.webp"; }, /PlateCarrierVest_Black/],
    ["a missing label on the award", (j: any) => { delete j["plate-carrier"].label; }, /label/],
  ])("throws on %s", (_name, mutate, pattern) => {
    const j = clone();
    mutate(j);
    expect(() => loadAwards(j)).toThrow(pattern);
  });
});

describe("isAwardPick / picksComplete", () => {
  const def = loadAwards(GOOD)["plate-carrier"]!;
  it("allows a class name listed in that slot only", () => {
    expect(isAwardPick(def, "vest", "PlateCarrierVest_Black")).toBe(true);
    expect(isAwardPick(def, "holster", "PlateCarrierVest_Black")).toBe(false);
    expect(isAwardPick(def, "armband", "PlateCarrierVest_Black")).toBe(false);
  });
  it("is complete only when every slot holds an allowed pick", () => {
    expect(picksComplete(def, { vest: "PlateCarrierVest_Black" })).toBe(false);
    expect(picksComplete(def, { vest: "PlateCarrierVest_Black", holster: "Nope" })).toBe(false);
    expect(picksComplete(def, { vest: "PlateCarrierVest_Black", holster: "PlateCarrierHolster_Black" })).toBe(true);
  });
});

describe("awardState", () => {
  const t = (iso: string) => new Date(iso);
  const base: AwardTimes = { placeBy: t("2026-09-29T00:00:00Z"), placedAt: null, liveFrom: null, expiresAt: null, revokedAt: null };
  const now = t("2026-09-25T00:00:00Z");

  it("is unplaced before the deadline with no spot", () => expect(awardState(base, now)).toBe("unplaced"));
  it("lapses AT the deadline, not after it", () => expect(awardState(base, base.placeBy)).toBe("lapsed"));
  it("is waiting once placed and not yet stamped", () =>
    expect(awardState({ ...base, placedAt: now }, now)).toBe("waiting"));
  it("is waiting when stamped but before live_from", () =>
    expect(awardState({ ...base, placedAt: now, liveFrom: t("2026-09-25T02:00:00Z"), expiresAt: t("2026-10-02T02:00:00Z") }, now)).toBe("waiting"));
  it("is live from live_from", () =>
    expect(awardState({ ...base, placedAt: now, liveFrom: now, expiresAt: t("2026-10-02T00:00:00Z") }, now)).toBe("live"));
  it("expires AT expires_at", () => {
    const g = { ...base, placedAt: now, liveFrom: now, expiresAt: t("2026-10-02T00:00:00Z") };
    expect(awardState(g, g.expiresAt!)).toBe("expired");
  });
  it("a placed grant never lapses, even past place_by", () =>
    expect(awardState({ ...base, placedAt: now }, t("2026-10-05T00:00:00Z"))).toBe("waiting"));
  it("revoked beats every other state", () =>
    expect(awardState({ ...base, placedAt: now, liveFrom: now, expiresAt: t("2026-10-02T00:00:00Z"), revokedAt: now }, now)).toBe("revoked"));
  it("only unplaced, waiting and live are open", () => {
    expect(["unplaced", "waiting", "live"].every((s) => isOpenAward(s as never))).toBe(true);
    expect(["revoked", "expired", "lapsed"].some((s) => isOpenAward(s as never))).toBe(false);
  });
});

describe("awardClock", () => {
  it("starts at the restart slot after the upload and runs whole days", () => {
    const c = awardClock(new Date("2026-09-22T13:10:00Z"), 7);
    expect(c.liveFrom.toISOString()).toBe("2026-09-22T14:00:00.000Z");
    expect(c.expiresAt.toISOString()).toBe("2026-09-29T14:00:00.000Z");
  });
  it("an upload exactly on a slot boundary waits for the NEXT slot", () => {
    expect(awardClock(new Date("2026-09-22T14:00:00Z"), 1).liveFrom.toISOString()).toBe("2026-09-22T16:00:00.000Z");
  });
});

describe("inAwardFile", () => {
  const t = (iso: string) => new Date(iso);
  const placed: AwardTimes = { placeBy: t("2026-09-29T00:00:00Z"), placedAt: t("2026-09-22T00:00:00Z"), liveFrom: null, expiresAt: null, revokedAt: null };
  it("includes a placed, unstamped grant", () => expect(inAwardFile(placed, t("2026-09-22T01:00:00Z"))).toBe(true));
  it("excludes an unplaced grant", () => expect(inAwardFile({ ...placed, placedAt: null }, t("2026-09-22T01:00:00Z"))).toBe(false));
  it("excludes a revoked grant", () => expect(inAwardFile({ ...placed, revokedAt: t("2026-09-22T00:30:00Z") }, t("2026-09-22T01:00:00Z"))).toBe(false));
  it("⚠️ drops out AWARD_REMOVAL_LEAD_MS before expiry, not at it", () => {
    const expiresAt = t("2026-09-29T14:00:00Z");
    const g = { ...placed, liveFrom: t("2026-09-22T14:00:00Z"), expiresAt };
    expect(inAwardFile(g, new Date(expiresAt.getTime() - AWARD_REMOVAL_LEAD_MS - 1))).toBe(true);
    expect(inAwardFile(g, new Date(expiresAt.getTime() - AWARD_REMOVAL_LEAD_MS))).toBe(false);
  });
});
