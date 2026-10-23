import { describe, it, expect } from "vitest";
import { ToneDetector } from "@/lib/radio/detector";
import { readsOf, spellGroups, type ToneRun } from "@/lib/radio/decode";

const CODES: Record<string, string> = { "0": "-----", "1": ".----", "2": "..---", "3": "...--", "4": "....-", "5": ".....", "6": "-....", "7": "--...", "8": "---..", "9": "----." };

/** Deterministic noise, so a failure reproduces. */
function rng(seed: number) {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296 - 0.5;
  };
}

/** One group of the broadcast at its own timing, 5 s of quiet either side; bursts are 200 ms of loud broadband noise at those ms. */
function synth(digits: string, { rate = 48_000, tone = 988, gainDb = 0, noise = 0.02, bursts = [] as number[] } = {}) {
  const els: ToneRun[] = [];
  let t = 5_000;
  for (const d of digits) {
    const code = CODES[d]!;
    [...code].forEach((s, i) => {
      els.push({ start: t, length: s === "." ? 90 : 485 });
      t += (s === "." ? 890 : 1900) + (i === code.length - 1 ? 400 : 0);
    });
  }
  const total = Math.ceil(((t + 5_000) / 1000) * rate);
  const out = new Float32Array(total);
  const g = 10 ** (gainDb / 20);
  const r = rng(7);
  for (let i = 0; i < total; i++) out[i] = noise * g * r() * 3.4;
  const ramp = Math.round(rate * 0.005);
  for (const e of els) {
    const a = Math.round((e.start / 1000) * rate);
    const n = Math.round((e.length / 1000) * rate);
    for (let i = 0; i < n; i++) {
      const env = Math.min(1, i / ramp, (n - i) / ramp);
      out[a + i]! += 0.5 * g * env * Math.sin((2 * Math.PI * tone * (a + i)) / rate);
    }
  }
  for (const b of bursts) {
    const a = Math.round((b / 1000) * rate);
    for (let i = 0; i < rate * 0.2; i++) out[a + i]! += 10 * noise * g * r() * 3.4;
  }
  return out;
}

function listen(audio: Float32Array, rate = 48_000, opts?: { tone?: number }) {
  const d = new ToneDetector(rate, opts);
  const runs: ToneRun[] = [];
  for (let i = 0; i < audio.length; i += 128) runs.push(...d.push(audio.subarray(i, i + 128)));
  const now = (audio.length / rate) * 1000;
  return { d, runs, reads: readsOf(spellGroups(runs, now)).map((r) => r.digits) };
}

describe("ToneDetector", () => {
  const clean = synth("0910442410");

  it("locks onto 988 Hz", () => {
    expect(Math.abs(listen(clean).d.tone! - 988)).toBeLessThanOrEqual(10);
  });

  it("finds another tone", () => {
    expect(Math.abs(listen(synth("0910442410", { tone: 1200 })).d.tone! - 1200)).toBeLessThanOrEqual(10);
  });

  it("decodes a clean group", () => {
    expect(listen(clean).reads).toEqual(["0910442410"]);
  });

  it("ignores gunshot bursts", () => {
    const bursts = [7_300, 16_000, 27_500, 39_100, 52_700, 66_000];
    expect(listen(synth("0910442410", { bursts })).reads).toEqual(["0910442410"]);
  });

  it("detects a quiet tone", () => {
    expect(listen(synth("0910442410", { gainDb: -30 })).reads).toEqual(["0910442410"]);
  });

  it("decodes at 44.1 kHz with the tone given", () => {
    expect(listen(synth("1001219970", { rate: 44_100 }), 44_100, { tone: 988 }).reads).toEqual(["1001219970"]);
  });
});
