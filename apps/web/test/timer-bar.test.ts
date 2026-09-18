import { describe, it, expect } from "vitest";
import { RESTART_PERIOD_MS, nextRestartAt } from "@factions/domain";
import { humanizeUntil, raidColumn, restartColumn, RESTART_SOON_MS } from "@/lib/timer-bar";

const FRI = new Date("2026-09-18T00:00:00.000Z");
const MON = new Date("2026-09-21T00:00:00.000Z");
/** The close that ended the previous weekend — what `boundaryAt` is midweek. */
const LAST_MON = new Date("2026-09-14T00:00:00.000Z");

const live = (now: Date) => raidColumn({ status: "live", opensAt: FRI, closesAt: MON, boundaryAt: FRI }, now);
const closed = (now: Date) => raidColumn({ status: "closed", opensAt: FRI, closesAt: MON, boundaryAt: LAST_MON }, now);

describe("humanizeUntil", () => {
  it("is coarse — days and hours, then hours, then minutes", () => {
    expect(humanizeUntil(FRI, new Date("2026-09-20T04:00:00.000Z"))).toBe("2d 4h");
    expect(humanizeUntil(FRI, new Date("2026-09-18T14:00:00.000Z"))).toBe("14h");
    expect(humanizeUntil(FRI, new Date("2026-09-18T00:38:00.000Z"))).toBe("38m");
  });

  it("never counts backwards past zero", () => {
    expect(humanizeUntil(MON, FRI)).toBe("0m");
  });
});

describe("raidColumn", () => {
  it("live names the close ahead and fills from the open", () => {
    const c = live(new Date("2026-09-20T10:00:00.000Z"));
    expect(c.label).toBe("Ends in");
    expect(c.value).toBe("14h");
    expect(c.tone).toBe("live");
    expect(c.target).toBe(MON.toISOString());
    // Friday 00:00 -> Monday 00:00 is 72h; 58h in.
    expect(c.fill).toBeCloseTo(58 / 72, 5);
  });

  it("closed names the open ahead and fills from the previous close", () => {
    const c = closed(new Date("2026-09-16T00:00:00.000Z"));
    expect(c.label).toBe("Starts in");
    expect(c.value).toBe("2d 0h");
    expect(c.tone).toBe("muted");
    expect(c.target).toBe(FRI.toISOString());
    // Mon 00:00 -> Fri 00:00 is 96h; 48h in.
    expect(c.fill).toBeCloseTo(0.5, 5);
  });

  /**
   * ⚠️ The one thing this column must never do. The boundary has passed with no
   * confirmed flip, so nobody knows whether base damage is on; painting the live
   * styling would tell a player raiding is open and let them find out by swinging
   * at a wall. It reads as the closed column does, and names the flip that is
   * missing rather than the state it wishes were true.
   */
  it("⚠️ unconfirmed never reads or paints as live", () => {
    const c = raidColumn({ status: "unconfirmed", pending: "open", opensAt: FRI, closesAt: MON, boundaryAt: FRI }, FRI);
    expect(c.label).toBe("Opening");
    expect(c.value).toBe("unconfirmed");
    expect(c.tone).toBe("warn");
    expect(c.tone).not.toBe("live");
  });

  // ⚠️ An unconfirmed CLOSE leaves base damage ON. "Opening" there is the wrong
  // word in the reassuring direction, which is the direction this design never takes.
  it("⚠️ an unconfirmed close reads as Closing, not Opening", () => {
    const c = raidColumn({ status: "unconfirmed", pending: "close", opensAt: FRI, closesAt: MON, boundaryAt: LAST_MON }, MON);
    expect(c.label).toBe("Closing");
    expect(c.value).toBe("unconfirmed");
  });

  it("⚠️ an unconfirmed column has no countdown and no fill to read", () => {
    const c = raidColumn({ status: "unconfirmed", pending: "open", opensAt: FRI, closesAt: MON, boundaryAt: FRI }, FRI);
    expect(c.target).toBeNull();
    expect(c.fill).toBe(0);
  });

  it("skipped says so, keeps the reason, and does not tick", () => {
    const c = raidColumn(
      { status: "skipped", opensAt: FRI, closesAt: MON, boundaryAt: FRI, skipReason: "launch weekend" },
      new Date("2026-09-16T00:00:00.000Z"),
    );
    expect(c.label).toBe("Skipped");
    expect(c.value).toBe("this week");
    expect(c.detail).toBe("launch weekend");
    expect(c.target).toBeNull();
    expect(c.fill).toBe(0);
    expect(c.tone).toBe("muted");
  });

  it("a skipped weekend with no recorded reason still renders", () => {
    const c = raidColumn({ status: "skipped", opensAt: FRI, closesAt: MON, boundaryAt: FRI }, FRI);
    expect(c.value).toBe("this week");
    expect(c.detail).toBe("");
  });

  it("⚠️ the fill never leaves the rule, whatever the clock says", () => {
    // A clock behind the boundary, and one past the instant ahead.
    expect(live(new Date("2026-09-17T00:00:00.000Z")).fill).toBe(0);
    expect(live(new Date("2026-09-22T00:00:00.000Z")).fill).toBe(1);
    expect(closed(new Date("2026-09-13T00:00:00.000Z")).fill).toBe(0);
    expect(closed(new Date("2026-09-19T00:00:00.000Z")).fill).toBe(1);
  });
});

describe("restartColumn", () => {
  const at = (iso: string) => new Date(iso);
  const next = at("2026-09-18T16:00:00.000Z");

  it("is mm:ss, zero-padded, counting down to the slot", () => {
    expect(restartColumn(next, at("2026-09-18T15:12:48.000Z")).value).toBe("47:12");
    expect(restartColumn(next, at("2026-09-18T15:59:05.000Z")).value).toBe("00:55");
    expect(restartColumn(next, at("2026-09-18T16:00:00.000Z")).value).toBe("00:00");
  });

  // A full period is 120 minutes, so the minutes field is not bounded by 99.
  it("carries three-digit minutes at the top of a period", () => {
    expect(restartColumn(next, at("2026-09-18T14:00:00.000Z")).value).toBe("120:00");
  });

  it("goes gold inside the last ten minutes, and not before", () => {
    expect(restartColumn(next, at("2026-09-18T15:49:59.000Z")).soon).toBe(false);
    expect(restartColumn(next, at("2026-09-18T15:50:00.000Z")).soon).toBe(true);
    expect(RESTART_SOON_MS).toBe(10 * 60_000);
  });

  // The restart rule drains: it shows time LEFT, not time elapsed.
  it("fills with the time remaining, a full rule at the top of a period", () => {
    expect(restartColumn(next, at("2026-09-18T14:00:00.000Z")).fill).toBe(1);
    expect(restartColumn(next, at("2026-09-18T15:00:00.000Z")).fill).toBeCloseTo(0.5, 5);
    expect(restartColumn(next, at("2026-09-18T16:00:00.000Z")).fill).toBe(0);
  });

  /**
   * ⚠️ A clock that has drifted past the slot must read 00:00 and an empty rule,
   * never a negative countdown or a rule wrapping back to full. The tick fires on
   * its own schedule; the bar is not the thing that decides a restart happened.
   */
  it("⚠️ never runs past zero when the clock overshoots the slot", () => {
    const late = restartColumn(next, at("2026-09-18T16:04:00.000Z"));
    expect(late.value).toBe("00:00");
    expect(late.fill).toBe(0);
    expect(late.soon).toBe(true);
  });

  /**
   * ⚠️ The composition RestartCountdown ticks on: the slot is recomputed against
   * the live clock, never counted down to an instant chosen once. Against a fixed
   * target, a tab left open across a restart reads 00:00 for as long as it stays
   * open — and this bar's whole job is to be left sitting on a second monitor.
   */
  it("⚠️ recomputing the slot each tick rolls over instead of sticking at zero", () => {
    const justAfter = at("2026-09-18T16:00:30.000Z");
    // What a fixed 16:00 target gives you half a minute later, forever.
    expect(restartColumn(at("2026-09-18T16:00:00.000Z"), justAfter).value).toBe("00:00");
    // What recomputing gives you: already counting to the 18:00 slot.
    expect(restartColumn(nextRestartAt(justAfter), justAfter).value).toBe("119:30");
    expect(restartColumn(nextRestartAt(justAfter), justAfter).soon).toBe(false);
  });

  it("a full period never overflows the rule", () => {
    const start = at("2026-09-18T14:00:00.000Z");
    for (let ms = 0; ms <= RESTART_PERIOD_MS; ms += 60_000) {
      const c = restartColumn(next, new Date(start.getTime() + ms));
      expect(c.fill).toBeGreaterThanOrEqual(0);
      expect(c.fill).toBeLessThanOrEqual(1);
    }
  });
});
