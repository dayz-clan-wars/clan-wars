import { readFileSync } from "node:fs";
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
function synth(digits: string, { rate = 48_000, tone = 988, gainDb = 0, noise = 0.02, bursts = [] as number[], hum = null as { hz: number; amp: number } | null, dips = [] as number[] } = {}) {
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
  // 60 ms of loud sound just beside the tone: it fills a reference band, not the beep.
  for (const at of dips) {
    const a = Math.round((at / 1000) * rate);
    for (let i = 0; i < rate * 0.06; i++) out[a + i]! += 0.5 * g * Math.sin((2 * Math.PI * (tone + 140) * i) / rate);
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

  it("a sound beside the tone for a moment does not cut a dash in two", () => {
    // Twice inside the first dash (5000–5485 ms): left in, they leave three
    // short pieces, and a short piece reads as a dot.
    const { runs, reads } = listen(synth("0910442410", { dips: [5_150, 5_300] }));
    const first = runs.filter((r) => r.start < 5_600 && r.start + r.length > 4_900);
    expect(first).toHaveLength(1);
    expect(first[0]!.length).toBeGreaterThan(400);
    expect(reads).toEqual(["0910442410"]);
  });

  it("decodes the real broadcast played through a speaker into a room", () => {
    // test/fixtures/bunker-radio-room.ulaw: 102 s of twitch.tv/videos/2908002004
    // from 45 s, band-limited to a speaker, with room echo, 20 dB down, 8 kHz
    // mu-law. Raised to 48 kHz, the rate a phone hands the page.
    const u = readFileSync(new URL("./fixtures/bunker-radio-room.ulaw", import.meta.url));
    const low = new Float32Array(u.length);
    for (let i = 0; i < u.length; i++) {
      const b = ~u[i]! & 0xff;
      const m = ((((b & 0x0f) << 3) + 0x84) << ((b >> 4) & 7)) - 0x84;
      low[i] = ((b & 0x80 ? -m : m) / 32768);
    }
    const audio = new Float32Array(low.length * 6);
    for (let i = 0; i < audio.length; i++) {
      const p = i / 6;
      const k = Math.floor(p);
      audio[i] = low[k]! + (p - k) * ((low[k + 1] ?? low[k]!) - low[k]!);
    }
    const { d, reads } = listen(audio);
    expect(Math.abs(d.tone! - 988)).toBeLessThanOrEqual(10);
    expect(reads).toContain("0910442410");
  });

  it("decodes at 44.1 kHz with the tone given", () => {
    expect(listen(synth("1001219970", { rate: 44_100 }), 44_100, { tone: 988 }).reads).toEqual(["1001219970"]);
  });
});
