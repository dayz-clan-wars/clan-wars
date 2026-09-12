import { describe, it, expect } from "vitest";
import {
  RESTART_PERIOD_MS,
  RESTART_GRACE_MS,
  restartSlot,
  truckWipeActive,
  weeklyWipeVehicle,
  wipeMondayFor,
  announceAtFor,
  rotationActiveFor,
} from "../src/restarts";

const at = (iso: string) => new Date(iso);

describe("restartSlot", () => {
  it("is two hours, ten minutes of grace", () => {
    expect(RESTART_PERIOD_MS).toBe(2 * 60 * 60_000);
    expect(RESTART_GRACE_MS).toBe(10 * 60_000);
  });
  it("⚠️ lands on EVEN UTC hours with no phase constant — the epoch is one", () => {
    expect(restartSlot(at("2026-09-12T14:00:00Z")).start).toEqual(at("2026-09-12T14:00:00Z"));
    expect(restartSlot(at("2026-09-12T15:59:59Z")).start).toEqual(at("2026-09-12T14:00:00Z"));
    expect(restartSlot(at("2026-09-12T13:59:59Z")).start).toEqual(at("2026-09-12T12:00:00Z"));
    expect(restartSlot(at("1970-01-01T00:00:00Z")).start).toEqual(at("1970-01-01T00:00:00Z"));
    // Every slot start of a day is an even hour.
    for (let h = 0; h < 24; h++) expect(restartSlot(at(`2026-03-29T${String(h).padStart(2, "0")}:30:00Z`)).start.getUTCHours() % 2).toBe(0);
  });
  it("is due only inside the grace window, and missed after it", () => {
    expect(restartSlot(at("2026-09-12T14:00:00Z"))).toMatchObject({ due: true, missedIfUnhandled: false });
    expect(restartSlot(at("2026-09-12T14:09:59Z"))).toMatchObject({ due: true, missedIfUnhandled: false });
    expect(restartSlot(at("2026-09-12T14:10:00Z"))).toMatchObject({ due: false, missedIfUnhandled: true });
    expect(restartSlot(at("2026-09-12T15:30:00Z"))).toMatchObject({ start: at("2026-09-12T14:00:00Z"), due: false, missedIfUnhandled: true });
  });
});

describe("truckWipeActive", () => {
  const at = (h: number) => new Date(Date.UTC(2026, 8, 12, h));

  // Level-triggered, NOT edge-triggered: every slot computes the state the
  // server should boot into, so a failed write self-heals at the next restart.
  it("is off for the slots inside the wipe window", () => {
    expect(truckWipeActive(at(8), 8, 10)).toBe(0);
  });

  it("is on for every slot outside the window", () => {
    for (const h of [0, 2, 4, 6, 10, 12, 14, 16, 18, 20, 22]) {
      expect(truckWipeActive(at(h), 8, 10)).toBe(1);
    }
  });

  it("re-enables at the on hour itself", () => {
    expect(truckWipeActive(at(10), 8, 10)).toBe(1);
  });

  // ⚠️ The self-healing property: a slot after a FAILED 10:00 write still
  // computes 1, so the next restart puts the trucks back without anyone paging.
  it("still computes on at 12:00, so a failed 10:00 write recovers", () => {
    expect(truckWipeActive(at(12), 8, 10)).toBe(1);
  });

  it("covers a window that wraps past midnight", () => {
    expect(truckWipeActive(at(22), 22, 2)).toBe(0);
    expect(truckWipeActive(at(0), 22, 2)).toBe(0);
    expect(truckWipeActive(at(2), 22, 2)).toBe(1);
    expect(truckWipeActive(at(20), 22, 2)).toBe(1);
  });

  it("spans multiple slots when the window is wider than one period", () => {
    expect(truckWipeActive(at(8), 8, 14)).toBe(0);
    expect(truckWipeActive(at(10), 8, 14)).toBe(0);
    expect(truckWipeActive(at(12), 8, 14)).toBe(0);
    expect(truckWipeActive(at(14), 8, 14)).toBe(1);
  });
});

describe("weeklyWipeVehicle", () => {
  const mon = (iso: string) => new Date(`${iso}T00:00:00Z`);

  it("starts the rotation at Olga on the anchor Monday", () => {
    expect(weeklyWipeVehicle(mon("2026-09-14")).name).toBe("Olga");
  });

  it("advances one vehicle per week, in the configured order", () => {
    const got = ["2026-09-14","2026-09-21","2026-09-28","2026-10-05","2026-10-12"]
      .map((d) => weeklyWipeVehicle(mon(d)).name);
    expect(got).toEqual(["Olga", "Gunter", "Hummer", "Ada", "Sarka"]);
  });

  it("wraps back to Olga on the sixth week", () => {
    expect(weeklyWipeVehicle(mon("2026-10-19")).name).toBe("Olga");
  });

  // ⚠️ The wipe and the announcement call this with different instants inside the
  // same week. If the hour changed the answer they could disagree by a vehicle.
  it("gives the same vehicle for every hour of its Monday", () => {
    const names = [0, 8, 10, 23].map((h) =>
      weeklyWipeVehicle(new Date(Date.UTC(2026, 8, 21, h))).name);
    expect(new Set(names)).toEqual(new Set(["Gunter"]));
  });

  it("runs backwards before the anchor without going negative", () => {
    expect(weeklyWipeVehicle(mon("2026-09-07")).name).toBe("Sarka");
    expect(weeklyWipeVehicle(mon("2026-08-31")).name).toBe("Ada");
  });
});

describe("wipeMondayFor", () => {
  it("finds the coming Monday 08:00Z from mid-week", () => {
    expect(wipeMondayFor(new Date("2026-09-12T20:45:00Z"), 8).toISOString())
      .toBe("2026-09-14T08:00:00.000Z");
  });

  it("finds tomorrow from the Sunday announcement moment", () => {
    expect(wipeMondayFor(new Date("2026-09-13T08:00:00Z"), 8).toISOString())
      .toBe("2026-09-14T08:00:00.000Z");
  });

  // ⚠️ Strictly after `now`: during the 08:00-10:00 wipe the tick must already be
  // looking at NEXT week, or it re-announces the wipe currently in progress.
  it("looks at next week once this week's wipe has started", () => {
    expect(wipeMondayFor(new Date("2026-09-14T08:00:00Z"), 8).toISOString())
      .toBe("2026-09-21T08:00:00.000Z");
    expect(wipeMondayFor(new Date("2026-09-14T09:30:00Z"), 8).toISOString())
      .toBe("2026-09-21T08:00:00.000Z");
  });

  it("still points at today's Monday in the hours before it", () => {
    expect(wipeMondayFor(new Date("2026-09-14T07:59:00Z"), 8).toISOString())
      .toBe("2026-09-14T08:00:00.000Z");
  });
});

describe("announceAtFor", () => {
  it("is exactly 24 hours before the wipe", () => {
    expect(announceAtFor(new Date("2026-09-14T08:00:00Z")).toISOString())
      .toBe("2026-09-13T08:00:00.000Z");
  });
});

describe("rotationActiveFor", () => {
  const WEEK1_MON_08 = new Date("2026-09-14T08:00:00Z"); // Olga's week
  const OLGA = "VehicleCivilianSedan";
  const GUNTER = "VehicleHatchback02";

  it("disables this week's vehicle inside the Monday window", () => {
    expect(rotationActiveFor(WEEK1_MON_08, 8, 10, OLGA)).toBe(0);
  });

  it("leaves every other vehicle enabled in that same window", () => {
    expect(rotationActiveFor(WEEK1_MON_08, 8, 10, GUNTER)).toBe(1);
  });

  it("re-enables this week's vehicle at the on hour", () => {
    expect(rotationActiveFor(new Date("2026-09-14T10:00:00Z"), 8, 10, OLGA)).toBe(1);
  });

  // ⚠️ The convergence guarantee. Without it, a bot down across Monday 10:00 leaves
  // that week's vehicle at 0 forever: by the time it returns the rotation has moved
  // on and nothing would ever put the old one back.
  it("enables last week's vehicle on a later slot, healing a missed re-enable", () => {
    expect(rotationActiveFor(new Date("2026-09-14T12:00:00Z"), 8, 10, OLGA)).toBe(1);
    expect(rotationActiveFor(new Date("2026-09-16T08:00:00Z"), 8, 10, OLGA)).toBe(1);
  });

  it("never disables anything on a day that is not Monday", () => {
    // 2026-09-16 is a Wednesday; 08:00 is inside the window hours but not a Monday.
    expect(rotationActiveFor(new Date("2026-09-16T08:00:00Z"), 8, 10, GUNTER)).toBe(1);
  });

  // A window whose onHour is before its offHour wraps past midnight — same as
  // truckWipeActive. Without the shared predicate this silently never wipes anything.
  describe("with a window that wraps past midnight (22 -> 2)", () => {
    it("disables this week's vehicle at the off hour", () => {
      expect(rotationActiveFor(new Date("2026-09-14T22:00:00Z"), 22, 2, OLGA)).toBe(0);
    });

    it("keeps this week's vehicle disabled after midnight, before the on hour", () => {
      expect(rotationActiveFor(new Date("2026-09-14T23:00:00Z"), 22, 2, OLGA)).toBe(0);
    });

    // ⚠️ Monday-only interaction: the Monday guard runs before the wrap check, so
    // once the calendar rolls to Tuesday the vehicle is back on immediately —
    // Mon 22:00 wipes, Tue 00:00 restores. Semantically odd, but consistent with
    // "Monday alone owns the rotation window".
    it("re-enables at Tuesday 00:00, even though the wrap window is still open", () => {
      expect(rotationActiveFor(new Date("2026-09-15T00:00:00Z"), 22, 2, OLGA)).toBe(1);
    });

    it("never disables anything outside the wrap window on Monday", () => {
      expect(rotationActiveFor(new Date("2026-09-14T12:00:00Z"), 22, 2, OLGA)).toBe(1);
    });
  });
});
