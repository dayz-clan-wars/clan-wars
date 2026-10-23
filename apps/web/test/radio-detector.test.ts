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
function synth(digits: string, { rate = 48_000, tone = 988, gainDb = 0, noise = 0.02, bursts = [] as number[], hum = null as { hz: number; amp: number } | null } = {}) {
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
  if (hum) for (let i = 0; i < total; i++) out[i]! += hum.amp * g * Math.sin((2 * Math.PI * hum.hz * i) / rate);
  for (const b of bursts) {
    const a = Math.round((b / 1000) * rate);
    for (let i = 0; i < rate * 0.2; i++) out[a + i]! += 10 * noise * g * r() * 3.4;
  }
  return out;
}

function listen(audio: Float32Array, rate = 48_000, opts?: { tone?: number }) {
  const d = new ToneDetector(rate, opts);
  let runs: ToneRun[] = [];
  let gen = d.generation;
  for (let i = 0; i < audio.length; i += 128) {
    const got = d.push(audio.subarray(i, i + 128));
    // A new lock replays recent audio: what the old one said is void.
    if (d.generation !== gen) [runs, gen] = [[], d.generation];
    runs.push(...got);
  }
  const now = (audio.length / rate) * 1000;
  const heard = runs.filter((r) => r.start >= d.heardFrom);
  return { d, runs, reads: readsOf(spellGroups(heard, now, d.heardFrom)).map((r) => r.digits) };
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

  it("a steady hum does not steal the lock when listening starts in silence", () => {
    const { d, reads } = listen(synth("0910442410", { hum: { hz: 600, amp: 0.02 } }));
    expect(Math.abs(d.tone! - 988)).toBeLessThanOrEqual(10);
    expect(reads).toEqual(["0910442410"]);
  });

  it("a tone held for seconds is not Morse: it searches again", () => {
    const { d, reads } = listen(synth("0910442410", { hum: { hz: 600, amp: 0.3 } }), 48_000, { tone: 600 });
    expect(Math.abs(d.tone! - 988)).toBeLessThanOrEqual(10);
    expect(reads.length).toBeGreaterThan(0);
    for (const r of reads) [...r].forEach((c, i) => expect(["?", "0910442410"[i]]).toContain(c));
  });

  it("a pause in the audio is silence, not a join", () => {
    // The context was suspended for 3 s mid-group: that audio never arrives.
    const audio = synth("0910442410");
    const cut = 48_000 * 40;
    const d = new ToneDetector(48_000, { tone: 988 });
    const runs: ToneRun[] = [];
    const before = audio.subarray(0, cut);
    const after = audio.subarray(cut + 48_000 * 3);
    for (let i = 0; i < before.length; i += 128) runs.push(...d.push(before.subarray(i, i + 128)));
    runs.push(...d.skip(3_000));
    for (let i = 0; i < after.length; i += 128) runs.push(...d.push(after.subarray(i, i + 128)));
    const reads = readsOf(spellGroups(runs, (audio.length / 48_000) * 1000)).map((r) => r.digits);
    expect(reads.length).toBeGreaterThan(0);
    for (const r of reads) [...r].forEach((c, i) => expect(["?", "0910442410"[i]]).toContain(c));
  });

  it("decodes at 44.1 kHz with the tone given", () => {
    expect(listen(synth("1001219970", { rate: 44_100 }), 44_100, { tone: 988 }).reads).toEqual(["1001219970"]);
  });
});
