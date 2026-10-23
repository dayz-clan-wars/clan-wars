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

/** Every digit is either unknown or right: a wrong digit shown as certain is the one thing the page must not do. */
function expectNoWrongDigits(read: string, truth: string) {
  [...read].forEach((c, i) => expect(["?", truth[i]], `${read} vs ${truth} at ${i}`).toContain(c));
}

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
    // Noise at its end makes the last group 48 elements: both ends heard, so
    // only digits both readings agree on are kept, and none may be wrong.
    expect(got).toHaveLength(4);
    expectNoWrongDigits(got[3]!, "0281002049");
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
    // 59 s: a whole group gap of silence has followed it, so its end is the group's end.
    expect(digits(runs.filter((r) => r.start < 53_000), 59_000)).toEqual(["????002049"]);
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

  it("two noise blips close together do not make a dot", () => {
    const rs = [...morse("0910442410"), { start: 9_000, length: 5 }, { start: 9_080, length: 5 }].sort((a, b) => a.start - b.start);
    expect(digits(rs, 200_000)).toEqual(["0910442410"]);
  });

  it("a phantom element before a group never shifts it into wrong digits", () => {
    const rs = [{ start: 9_110, length: 90 }, ...morse("0910442410")];
    const got = digits(rs, 200_000);
    expect(got).toHaveLength(1);
    expectNoWrongDigits(got[0]!, "0910442410");
  });

  it("two lost elements in a row split a group without wrong digits", () => {
    const rs = morse("0910442410");
    rs.splice(16, 2); // two dashes of the fourth digit: over 4 s of silence mid-group
    const got = digits(rs, 200_000);
    expect(got.length).toBeGreaterThan(0);
    for (const d of got) expectNoWrongDigits(d, "0910442410");
  });

  it("a group under way when the audio starts is a tail, however late that is", () => {
    const rs = morse("0910442410", 30_000).slice(7);
    const reads = readsOf(spellGroups(rs, 200_000, rs[0]!.start - 1_000)).map((r) => r.digits);
    expect(reads).toEqual(["??10442410"]);
  });

  it("a blip in the middle of the group gap does not merge two groups", () => {
    const withBlip = [...runs, { start: 56_000, length: 120 }].sort((a, b) => a.start - b.start);
    expect(digits(withBlip).slice(0, 3)).toEqual(["????002049", "0910442410", "1001219970"]);
  });

  it("a whole synthetic group reads in full", () => {
    expect(digits(morse("1001219970"), 200_000)).toEqual(["1001219970"]);
  });

  it.each([0.85, 1.15])("decodes at %s× speed", (k) => {
    const scaled = runs.map((r) => ({ start: r.start * k, length: r.length * k }));
    expect(digits(scaled, fx.durationMs * k).slice(1, 3)).toEqual(["0910442410", "1001219970"]);
  });
});
