import { describe, it, expect } from "vitest";
import { readsOf, spellGroups } from "@/lib/radio/decode";
import { TapKey } from "@/lib/radio/tap";
import { tally } from "@/lib/radio/tally";

const CODES: Record<string, string> = { "0": "-----", "1": ".----", "2": "..---", "3": "...--", "4": "....-", "5": ".....", "6": "-....", "7": "--...", "8": "---..", "9": "----." };

/** A small seeded generator, so a failure replays. */
function rng(seed: number) {
  return () => ((seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);
}

/**
 * A player tapping along to the three groups: each press lands up to ±`jitter`
 * ms off the beep, and lasts however long a thumb holds, not 90 or 485 ms.
 */
function tapAlong(groups: string[], jitter: number, seed: number) {
  const r = rng(seed);
  const key = new TapKey(1000);
  let t = 1000 + 7000;
  for (const g of groups) {
    for (const d of g) {
      const code = CODES[d]!;
      [...code].forEach((s, i) => {
        const at = t + (r() * 2 - 1) * jitter;
        key.press(at);
        key.release(at + (s === "." ? 20 + r() * 170 : 330 + r() * 350));
        t += (s === "." ? 890 : 1900) + (i === code.length - 1 ? 400 : 0);
      });
    }
    t += 6800;
  }
  return { key, end: t + 1000 };
}

const TRUTH = ["0910442410", "1001219970", "0281002049"];

describe("tapping along", () => {
  it("decodes three groups tapped with a human's timing", () => {
    for (const seed of [1, 2, 3, 4, 5, 6, 7, 8]) {
      const { key, end } = tapAlong(TRUTH, 100, seed);
      const reads = readsOf(spellGroups(key.runs, key.elapsed(end))).map((x) => x.digits);
      expect(reads, `seed ${seed}`).toEqual(TRUTH);
    }
  });

  it("sloppier taps lose digits to '?', never to a wrong digit", () => {
    for (let seed = 1; seed <= 40; seed++) {
      const { key, end } = tapAlong(TRUTH, 150, seed);
      for (const read of readsOf(spellGroups(key.runs, key.elapsed(end))).map((x) => x.digits)) {
        const truth = TRUTH.find((t) => [...read].filter((c, i) => c === t[i]).length >= 1 && [...read].every((c, i) => c === "?" || c === t[i]));
        expect(truth, `seed ${seed}: ${read} matches no bunker digit for digit`).toBeDefined();
      }
    }
  });

  it("two passes settle all three bunkers", () => {
    const { key, end } = tapAlong([...TRUTH, ...TRUTH], 150, 9);
    const cards = tally(readsOf(spellGroups(key.runs, key.elapsed(end))));
    expect(cards.map((c) => c.grid + c.key)).toEqual(TRUTH);
    expect(cards.every((c) => c.settled)).toBe(true);
  });

  it("a tap too quick for the noise filter still counts", () => {
    const key = new TapKey(0);
    key.press(100);
    key.release(105);
    expect(key.runs[0]!.length).toBeGreaterThanOrEqual(60);
  });

  it("a release with no press, or a second press while held, changes nothing", () => {
    const key = new TapKey(0);
    key.release(50);
    key.press(100);
    key.press(300);
    expect(key.pressed).toBe(true);
    key.release(600);
    expect(key.runs).toEqual([{ start: 100, length: 500 }]);
    expect(key.pressed).toBe(false);
  });
});
