import { describe, it, expect } from "vitest";
import { RESTART_PERIOD_MS, RESTART_GRACE_MS, restartSlot } from "../src/restarts";

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
