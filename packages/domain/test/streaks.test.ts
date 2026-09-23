import { describe, it, expect } from "vitest";
import { streakOf } from "../src/streaks";
const t = (s: number) => new Date(1_700_000_000_000 + s * 1000);
const K = (killer: string | null, victim: string, at: number, ff = false) => ({ killer, victim, friendlyFire: ff, occurredAt: t(at) });

describe("streakOf", () => {
  it("counts PvP kills until a PvP death, and reports when each length was first reached", () => {
    const rows = [K("A", "x", 1), K("A", "y", 2), K("z", "A", 3), K("A", "x", 4), K("A", "y", 5), K("A", "z", 6)];
    const s = streakOf(rows, "A");
    expect(s.best).toBe(3);
    expect(s.reachedAt(2)).toEqual(t(2));
    expect(s.reachedAt(3)).toEqual(t(6));
    expect(s.reachedAt(4)).toBeNull();
  });
  // ⚠️ Inverted on 2026-09-21. Friendly fire is skipped on BOTH sides: it does not
  // extend the killer's run AND it does not reset the victim's. A's run here is
  // x(1), y(3), x(5) = 3 unbroken — the friendly kill at 2 adds nothing and the
  // friendly death at 4 takes nothing. Before this it read 2.
  it("friendly fire neither extends the killer's run nor breaks the victim's", () => {
    const rows = [K("A", "x", 1), K("A", "m", 2, true), K("A", "y", 3), K("m", "A", 4, true), K("A", "x", 5)];
    expect(streakOf(rows, "A").best).toBe(3);
  });
  // ⚠️ The counterweight: a REAL death still resets, so the test above cannot pass
  // against a streakOf that has simply stopped resetting.
  it("a non-friendly death still breaks the run", () => {
    const rows = [K("A", "x", 1), K("A", "y", 2), K("z", "A", 3), K("A", "x", 4)];
    expect(streakOf(rows, "A").best).toBe(2);
  });
  it("a non-player death (no killer) does not reset", () => {
    expect(streakOf([K("A", "x", 1), K(null, "A", 2), K("A", "y", 3)], "A").best).toBe(2);
  });
  it("reachedIndex picks the actual crossing row, even when two of the owner's kills share one timestamp", () => {
    // Both kills land at t(1) — same-second log resolution. reachedAt(1) and reachedAt(2)
    // are both t(1) and cannot tell the rows apart; reachedIndex must still point at the
    // right one (0 for the kill that brought the run to 1, 1 for the kill that brought it to 2).
    const rows = [K("A", "x", 1), K("A", "y", 1)];
    const s = streakOf(rows, "A");
    expect(s.reachedAt(1)).toEqual(t(1));
    expect(s.reachedAt(2)).toEqual(t(1));
    expect(s.reachedIndex(1)).toBe(0);
    expect(s.reachedIndex(2)).toBe(1);
    expect(rows[s.reachedIndex(2)!]).toBe(rows[1]);
  });
  it("a Hub kill neither extends a run nor, as a death, resets one", () => {
    const at = (n: number) => new Date(Date.UTC(2026, 8, 20, 0, n));
    // 3, and only 3: a Hub death that reset the run gives 2, a Hub kill that extended it gives 4.
    const rows = [
      { killer: "A", victim: "B", friendlyFire: false, occurredAt: at(1) },
      { killer: "A", victim: "B", friendlyFire: false, occurredAt: at(2) },
      { killer: "B", victim: "A", friendlyFire: false, atHub: true, occurredAt: at(3) },
      { killer: "A", victim: "B", friendlyFire: false, occurredAt: at(4) },
      { killer: "A", victim: "B", friendlyFire: false, atHub: true, occurredAt: at(5) },
    ];
    expect(streakOf(rows, "A").best).toBe(3);
  });
});
