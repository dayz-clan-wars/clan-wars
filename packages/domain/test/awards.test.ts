import { describe, expect, it } from "vitest";
import {
  loadAwards, isAwardPick, picksComplete, awardState, isOpenAward, awardClock, inAwardFile, type AwardTimes,
  awardTimeLeftMs, awardClockMs, timeLeftText,
} from "../src/awards";
import { AWARD_REMOVAL_LEAD_MS } from "../src/rules";
import raw from "../assets/awards.json";
import { awardsCatalogue, expandAwardSlots } from "../src/awards-catalogue";
import { boosterCatalogue } from "../src/booster-catalogue";
import { KIT_GRID_ORDER, KIT_SLOTS, KIT_SLOT_LABELS } from "../src/booster-kit";

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
    const pc = awardsCatalogue()["plate-carrier"]!;
    expect(pc.durationDays).toBe(7);
    for (const slot of ["vest", "pouches", "holster"]) expect(pc.slots[slot]!.items).toHaveLength(6);
  });

  it.each([
    ["an award key that is not kebab-case", (j: any) => { j["Plate_Carrier"] = j["plate-carrier"]; delete j["plate-carrier"]; }, /Plate_Carrier/],
    ["a non-integer duration", (j: any) => { j["plate-carrier"].durationDays = 1.5; }, /durationDays/],
    ["a zero duration", (j: any) => { j["plate-carrier"].durationDays = 0; }, /durationDays/],
    ["a duration past AWARD_MAX_DAYS", (j: any) => { j["plate-carrier"].durationDays = 91; }, /durationDays/],
    ["an award with no slots", (j: any) => { j["plate-carrier"].slots = {}; }, /no slots/],
    ["a slot with no items", (j: any) => { j["plate-carrier"].slots.vest.items = []; }, /vest/],
    ["a duplicate class name in a slot", (j: any) => { j["plate-carrier"].slots.vest.items.push({ className: "PlateCarrierVest_Black", label: "Other" }); }, /PlateCarrierVest_Black/],
    ["a duplicate label in a slot", (j: any) => { j["plate-carrier"].slots.vest.items.push({ className: "PlateCarrierVest", label: "Plate Carrier (Black)" }); }, /label/],
    ["an image path not named after the class", (j: any) => { j["plate-carrier"].slots.vest.items[0].image = "items/Other.webp"; }, /PlateCarrierVest_Black/],
    ["a missing label on the award", (j: any) => { delete j["plate-carrier"].label; }, /label/],
    ["extras that is not an array", (j: any) => { j["plate-carrier"].slots.vest.items[0].extras = "Mag_STANAG_30Rnd"; }, /extras/],
    ["an empty extras", (j: any) => { j["plate-carrier"].slots.vest.items[0].extras = []; }, /extras/],
    ["a non-string in extras", (j: any) => { j["plate-carrier"].slots.vest.items[0].extras = [7]; }, /extras/],
    ["an empty string in extras", (j: any) => { j["plate-carrier"].slots.vest.items[0].extras = [""]; }, /extras/],
  ])("throws on %s", (_name, mutate, pattern) => {
    const j = clone();
    mutate(j);
    expect(() => loadAwards(j)).toThrow(pattern);
  });

  it("keeps extras, repeats included, and does not count them as duplicate class names", () => {
    const j = clone();
    j["plate-carrier"].slots.vest.items[0].extras = ["Mag_STANAG_30Rnd", "Mag_STANAG_30Rnd", "PlateCarrierHolster_Black"];
    const item = loadAwards(j)["plate-carrier"]!.slots.vest!.items[0]!;
    expect(item.extras).toEqual(["Mag_STANAG_30Rnd", "Mag_STANAG_30Rnd", "PlateCarrierHolster_Black"]);
  });
});

describe("the booster kit award", () => {
  const kit = awardsCatalogue()["booster-kit"]!;
  const booster = boosterCatalogue();

  it("is in the catalogue, 7 days by default", () => {
    expect(kit.label).toBe("Booster Kit");
    expect(kit.durationDays).toBe(7);
  });

  // ⚠️ Derived, not copied: a jacket added to the booster catalogue must be
  // pickable in the award too, with no second edit.
  it("has the booster catalogue's nine slots, in the kit page's order, with the same items", () => {
    expect(Object.keys(kit.slots)).toEqual([...KIT_GRID_ORDER]);
    for (const slot of KIT_SLOTS) {
      expect(kit.slots[slot]!.label).toBe(KIT_SLOT_LABELS[slot]);
      expect(kit.slots[slot]!.items).toEqual(booster[slot]);
    }
  });

  it("the plate carrier is unchanged by the expansion", () => {
    expect(awardsCatalogue()["plate-carrier"]).toEqual(loadAwards({ "plate-carrier": raw["plate-carrier"] })["plate-carrier"]);
  });

  it("refuses an unknown slotsFrom, and slotsFrom beside slots", () => {
    expect(() => expandAwardSlots({ x: { label: "X", durationDays: 1, slotsFrom: "nope" } })).toThrow(/slotsFrom nope/u);
    expect(() => expandAwardSlots({ x: { label: "X", durationDays: 1, slotsFrom: "booster-catalogue", slots: {} } })).toThrow(/both/u);
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

describe("the weapon kit award", () => {
  const kit = awardsCatalogue()["weapon-kit"]!;

  it("is one Weapon slot, 3 days by default", () => {
    expect(kit.label).toBe("Weapon Kit");
    expect(kit.durationDays).toBe(3);
    expect(Object.keys(kit.slots)).toEqual(["weapon"]);
    expect(kit.slots.weapon!.label).toBe("Weapon");
  });

  // ⚠️ The loadouts the owner signed off on one by one (spec §3). A change
  // here is a balance change, so it has to be made on purpose.
  it("has the twelve signed-off loadouts", () => {
    const loadouts = Object.fromEntries(kit.slots.weapon!.items.map((i) => [i.className, i.extras]));
    expect(loadouts).toEqual({
      M4A1_Green: ["M4_OEBttstck", "M4_RISHndgrd_Green", "ACOGOptic_6x", "M4_Suppressor", "Mag_STANAG_60Rnd", "Mag_STANAG_60Rnd"],
      M16A2: ["M4_Suppressor", "Mag_STANAG_60Rnd", "Mag_STANAG_60Rnd"],
      AKM: ["AK_PlasticBttstck", "AK_PlasticHndgrd", "KobraOptic", "Battery9V", "AK_Suppressor", "Mag_AKM_Drum75Rnd", "Mag_AKM_Drum75Rnd"],
      AK101_Green: ["AK_FoldingBttstck_Green", "AK_RailHndgrd_Green", "KobraOptic", "Battery9V", "AK_Suppressor", "Mag_AK101_30Rnd", "Mag_AK101_30Rnd"],
      AK74_Green: ["AK_PlasticBttstck_Green", "AK_RailHndgrd_Green", "KobraOptic", "Battery9V", "AK_Suppressor", "Mag_AK74_45Rnd", "Mag_AK74_45Rnd"],
      FAL: ["Fal_OeBttstck", "ACOGOptic_6x", "Mag_FAL_20Rnd", "Mag_FAL_20Rnd"],
      SCARH: ["SCAR_PrecisionBttstck", "ACOGOptic_6x", "Mag_SCARH_20Rnd", "Mag_SCARH_20Rnd"],
      Aug: ["ACOGOptic_6x", "M4_Suppressor", "Mag_STANAG_60Rnd", "Mag_STANAG_60Rnd"],
      ASVAL: ["ACOGOptic_6x", "Mag_Vikhr_30Rnd", "Mag_Vikhr_30Rnd"],
      SVD: ["PSO6Optic", "Battery9V", "AK_Suppressor", "Mag_SVD_10Rnd", "Mag_SVD_10Rnd"],
      M14: ["MK4Optic_black", "Mag_M14_20Rnd", "Mag_M14_20Rnd"],
      SV98: ["MK4Optic_black", "Mag_SV98_10Rnd", "Mag_SV98_10Rnd"],
    });
  });

  it("has art for every gun", () => {
    for (const i of kit.slots.weapon!.items) expect(i.image).toBe(`items/${i.className}.webp`);
  });
});

describe("awardTimeLeftMs", () => {
  const H = 3_600_000; const D = 24 * H;
  const at = new Date("2026-09-30T12:00:00Z");
  const g = (o: Partial<{ liveFrom: Date | null; expiresAt: Date | null; remainingMs: number | null; durationDays: number }>) =>
    ({ liveFrom: null, expiresAt: null, remainingMs: null, durationDays: 3, ...o });

  it("is the full length before any clock or transfer", () => {
    expect(awardTimeLeftMs(g({}), at)).toBe(3 * D);
  });
  it("is a previous transfer's time left, unchanged, until the clock starts again", () => {
    expect(awardTimeLeftMs(g({ remainingMs: 5 * H }), at)).toBe(5 * H);
  });
  it("is the whole length when stamped but not live yet", () => {
    const liveFrom = new Date(at.getTime() + H);
    expect(awardTimeLeftMs(g({ liveFrom, expiresAt: new Date(liveFrom.getTime() + 3 * D) }), at)).toBe(3 * D);
  });
  it("counts down from now once live", () => {
    expect(awardTimeLeftMs(g({ liveFrom: new Date(at.getTime() - D), expiresAt: new Date(at.getTime() + 2 * D) }), at)).toBe(2 * D);
  });
  it("⚠️ never goes below zero", () => {
    expect(awardTimeLeftMs(g({ liveFrom: new Date(at.getTime() - D), expiresAt: new Date(at.getTime() - 1) }), at)).toBe(0);
  });
});

describe("awardClockMs", () => {
  it("runs a given length from the next restart, and awardClock is its day form", () => {
    const up = new Date("2026-09-30T13:10:00Z");
    const c = awardClockMs(up, 5 * 3_600_000);
    expect(c.liveFrom.toISOString()).toBe("2026-09-30T14:00:00.000Z");
    expect(c.expiresAt.getTime() - c.liveFrom.getTime()).toBe(5 * 3_600_000);
    expect(awardClock(up, 2)).toEqual(awardClockMs(up, 2 * 86_400_000));
  });
});

describe("timeLeftText", () => {
  it.each([
    [2 * 86_400_000 + 5 * 3_600_000, "2 days 5 hours"],
    [86_400_000, "1 day"],
    [3 * 86_400_000 + 3_600_000, "3 days 1 hour"],
    [5 * 3_600_000 + 59 * 60_000, "5 hours"],
    [59 * 60_000, "less than an hour"],
    [0, "less than an hour"],
  ])("%d ms reads %s", (ms, text) => {
    expect(timeLeftText(ms)).toBe(text);
  });
});
