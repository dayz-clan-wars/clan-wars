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
  it("friendly fire neither extends the killer's run nor spares the victim's", () => {
    const rows = [K("A", "x", 1), K("A", "m", 2, true), K("A", "y", 3), K("m", "A", 4, true), K("A", "x", 5)];
    expect(streakOf(rows, "A").best).toBe(2);
  });
  it("a non-player death (no killer) does not reset", () => {
    expect(streakOf([K("A", "x", 1), K(null, "A", 2), K("A", "y", 3)], "A").best).toBe(2);
  });
});
