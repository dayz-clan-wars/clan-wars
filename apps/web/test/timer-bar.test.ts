import { describe, it, expect } from "vitest";
import { RESTART_PERIOD_MS, nextRestartAt } from "@factions/domain";
import { restartColumn, RESTART_SOON_MS } from "@/lib/timer-bar";

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
