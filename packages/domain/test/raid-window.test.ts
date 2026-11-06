import { describe, it, expect } from "vitest";
import { raidWindowAt } from "../src/raid-window";

// 2026-09-18 is a Friday. The window is Fri 14:00 → Sun 14:00. All instants UTC.
const FRI_OPEN = new Date("2026-09-18T14:00:00.000Z");
const SUN_CLOSE = new Date("2026-09-20T14:00:00.000Z");

describe("raidWindowAt", () => {
  it("is open exactly at the Friday 14:00 boundary", () => {
    const s = raidWindowAt(FRI_OPEN, []);
    expect(s.phase).toBe("open");
    expect(s.baseDamageDisabled).toBe(false);
    expect(s.opensAt.toISOString()).toBe(FRI_OPEN.toISOString());
    expect(s.closesAt.toISOString()).toBe(SUN_CLOSE.toISOString());
  });

  it("is still closed one millisecond before the Friday 14:00 boundary", () => {
    const s = raidWindowAt(new Date(FRI_OPEN.getTime() - 1), []);
    expect(s.phase).toBe("closed");
    expect(s.baseDamageDisabled).toBe(true);
    // The window it points at is the one about to open.
    expect(s.opensAt.toISOString()).toBe(FRI_OPEN.toISOString());
  });

  it("is closed exactly at the Sunday boundary — the window is half-open", () => {
    const s = raidWindowAt(SUN_CLOSE, []);
    expect(s.phase).toBe("closed");
    expect(s.baseDamageDisabled).toBe(true);
    // ⚠️ Points at NEXT Friday, not the one that just closed.
    expect(s.opensAt.toISOString()).toBe("2026-09-25T14:00:00.000Z");
  });

  it("is open one millisecond before the Sunday boundary", () => {
    const s = raidWindowAt(new Date(SUN_CLOSE.getTime() - 1), []);
    expect(s.phase).toBe("open");
    expect(s.baseDamageDisabled).toBe(false);
  });

  it("is open in the middle of the weekend", () => {
    const s = raidWindowAt(new Date("2026-09-19T13:45:00.000Z"), []);
    expect(s.phase).toBe("open");
  });

  it("is skipped when a skip names this window's opensAt", () => {
    const s = raidWindowAt(new Date("2026-09-19T13:45:00.000Z"), [
      { opensAt: FRI_OPEN, reason: "first weekend after launch" },
    ]);
    expect(s.phase).toBe("skipped");
    expect(s.baseDamageDisabled).toBe(true);
    expect(s.skipReason).toBe("first weekend after launch");
  });

  it("⚠️ a skip for a DIFFERENT window does not affect this one", () => {
    const s = raidWindowAt(new Date("2026-09-19T13:45:00.000Z"), [
      { opensAt: new Date("2026-09-25T14:00:00.000Z"), reason: "some other weekend" },
    ]);
    expect(s.phase).toBe("open");
    expect(s.skipReason).toBeUndefined();
  });

  it("⚠️ a skip on a CLOSED midweek instant still reports the coming window as skipped", () => {
    // Wednesday, looking forward at a weekend that will not happen.
    const s = raidWindowAt(new Date("2026-09-16T12:00:00.000Z"), [
      { opensAt: FRI_OPEN, reason: "first weekend after launch" },
    ]);
    expect(s.phase).toBe("skipped");
    expect(s.baseDamageDisabled).toBe(true);
    expect(s.skipReason).toBe("first weekend after launch");
    expect(s.opensAt.toISOString()).toBe(FRI_OPEN.toISOString());
  });

  it("⚠️ boundaryAt is the open instant while the window is open", () => {
    expect(raidWindowAt(new Date("2026-09-19T13:45:00.000Z"), []).boundaryAt.toISOString())
      .toBe(FRI_OPEN.toISOString());
  });

  it("⚠️ boundaryAt is the PREVIOUS close midweek, never the coming one", () => {
    // Wednesday. Base damage is off because the PREVIOUS Sunday's close turned it
    // off; the coming Sunday has not happened and nothing can have recorded it.
    const s = raidWindowAt(new Date("2026-09-16T12:00:00.000Z"), []);
    expect(s.phase).toBe("closed");
    expect(s.closesAt.toISOString()).toBe("2026-09-20T14:00:00.000Z"); // ahead
    expect(s.boundaryAt.toISOString()).toBe("2026-09-13T14:00:00.000Z"); // behind
  });

  it("⚠️ boundaryAt is never in the future, at any instant across a full week", () => {
    // The invariant every consumer leans on. Half-hourly across a week.
    const start = Date.parse("2026-09-14T00:00:00.000Z");
    for (let i = 0; i < 7 * 48; i++) {
      const when = new Date(start + i * 30 * 60 * 1000);
      expect(raidWindowAt(when, []).boundaryAt.getTime()).toBeLessThanOrEqual(when.getTime());
    }
  });

  it("tolerates duplicate skip rows for the same window", () => {
    const s = raidWindowAt(FRI_OPEN, [
      { opensAt: FRI_OPEN, reason: "first" },
      { opensAt: FRI_OPEN, reason: "second" },
    ]);
    expect(s.phase).toBe("skipped");
    expect(s.skipReason).toBe("first");
  });

  it("pins the Friday 14:00 / Sunday 14:00 edges a week on", () => {
    const iso = (t: string) => raidWindowAt(new Date(t), []);
    const before = iso("2026-11-13T13:59:59Z");
    expect(before.phase).toBe("closed");
    expect(before.opensAt.toISOString()).toBe("2026-11-13T14:00:00.000Z");
    const open = iso("2026-11-13T14:00:00Z");
    expect(open.phase).toBe("open");
    expect(open.closesAt.toISOString()).toBe("2026-11-15T14:00:00.000Z");
    expect(open.boundaryAt.toISOString()).toBe(open.opensAt.toISOString());
    expect(iso("2026-11-15T13:59:59Z").phase).toBe("open");
    const closed = iso("2026-11-15T14:00:00Z");
    expect(closed.phase).toBe("closed");
    expect(closed.boundaryAt.toISOString()).toBe("2026-11-15T14:00:00.000Z");
    expect(closed.opensAt.toISOString()).toBe("2026-11-20T14:00:00.000Z");
  });

  it("⚠️ the 2026-11-06 deploy instant, mid-window, stays open and closes Sunday 14:00", () => {
    const s = raidWindowAt(new Date("2026-11-06T18:00:00Z"), []);
    expect(s.phase).toBe("open");
    expect(s.opensAt.toISOString()).toBe("2026-11-06T14:00:00.000Z");
    expect(s.closesAt.toISOString()).toBe("2026-11-08T14:00:00.000Z");
  });

  it("a skip naming a 14:00 opensAt suppresses that window, seen from Saturday 00:00", () => {
    const s = raidWindowAt(new Date("2026-11-14T00:00:00Z"), [
      { opensAt: new Date("2026-11-13T14:00:00Z"), reason: "test" },
    ]);
    expect(s.phase).toBe("skipped");
  });
});
