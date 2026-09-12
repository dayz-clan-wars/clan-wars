import { describe, it, expect } from "vitest";
import { RESTART_PERIOD_MS, RESTART_GRACE_MS, restartSlot, truckWipeActive } from "../src/restarts";

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
