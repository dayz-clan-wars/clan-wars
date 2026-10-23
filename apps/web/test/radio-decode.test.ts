import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it, expect } from "vitest";
import { readsOf, spellGroups, toDigits, type ToneRun } from "@/lib/radio/decode";

// The tone runs of a real broadcast (One Life Nasdara stream, 8 min), raw:
// 5 ms blips and noise-chopped dashes included, as the detector hands them over.
const fx = JSON.parse(readFileSync(join(__dirname, "fixtures", "bunker-radio-runs.json"), "utf8")) as { durationMs: number; runs: [number, number][] };
const runs: ToneRun[] = fx.runs.map(([start, length]) => ({ start, length }));
const digits = (rs: ToneRun[], now = fx.durationMs) => readsOf(spellGroups(rs, now)).map((r) => r.digits);

const CODES: Record<string, string> = { "0": "-----", "1": ".----", "2": "..---", "3": "...--", "4": "....-", "5": ".....", "6": "-....", "7": "--...", "8": "---..", "9": "----." };

/** A group at the broadcast's own timing, starting at `t0`. */
function morse(ds: string, t0 = 10_000): ToneRun[] {
  const out: ToneRun[] = [];
  let t = t0;
  for (const d of ds) {
    const code = CODES[d]!;
    [...code].forEach((s, i) => {
      out.push({ start: t, length: s === "." ? 90 : 485 });
      t += (s === "." ? 890 : 1900) + (i === code.length - 1 ? 400 : 0);
    });
  }
  return out;
}

describe("the decoder", () => {
  it("decodes the recording", () => {
    const got = digits(runs);
    expect(got.slice(0, 3)).toEqual(["????002049", "0910442410", "1001219970"]);
    expect(got[3]).toMatch(/^0281002/);
    expect(got).toHaveLength(4);
  });

  it("puts back the dot drowned out at 59 s", () => {
    const g = spellGroups(runs, fx.durationMs).find((x) => Math.abs(x.start - 59_160) < 50)!;
    expect(g.symbols).toHaveLength(50);
  });

  it("reads a dash chopped by noise as one dash", () => {
    const rs = morse("0");
    const [first, ...rest] = rs;
    const chopped = [{ start: first!.start, length: 200 }, { start: first!.start + 230, length: 255 }, ...rest];
    expect(toDigits(spellGroups(chopped, 30_000)[0]!.symbols)).toBe("0");
  });

  it("tail group aligns right", () => {
    // 57 s: the 4 s silence after it has passed, so it is closed.
    expect(digits(runs.filter((r) => r.start < 53_000), 57_000)).toEqual(["????002049"]);
  });

  it("a tail still coming in is no read yet", () => {
    // Neither its start nor its end heard: no way to align it.
    expect(digits(runs.filter((r) => r.start < 53_000), 53_000)).toEqual([]);
  });

  it("cut-off group aligns left and stays open", () => {
    const gs = spellGroups(runs.filter((r) => r.start < 270_000), 270_500);
    expect(gs.at(-1)!.open).toBe(true);
    expect(readsOf(gs).at(-1)!.digits).toBe("028???????"); // 18 elements in: three digits so far
  });

  it("stray blip in the group gap", () => {
    const withBlip = [...runs, { start: 55_000, length: 120 }].sort((a, b) => a.start - b.start);
    const got = digits(withBlip);
    expect(got).toContain("0910442410");
    expect(got).toHaveLength(4);
  });

  it("a whole synthetic group reads in full", () => {
    expect(digits(morse("1001219970"), 200_000)).toEqual(["1001219970"]);
  });

  it.each([0.85, 1.15])("decodes at %s× speed", (k) => {
    const scaled = runs.map((r) => ({ start: r.start * k, length: r.length * k }));
    expect(digits(scaled, fx.durationMs * k).slice(1, 3)).toEqual(["0910442410", "1001219970"]);
  });
});
