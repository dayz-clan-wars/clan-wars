/**
 * Microphone samples in, tone runs out (lib/radio/decode.ts reads them).
 *
 * Pure: no Web Audio here, so vitest drives it with synthetic audio. The
 * browser side (capture.ts) only hands it blocks of samples.
 *
 * Tone-on is two tests, both needed:
 *  - the tone band stands 15 dB above two reference bands ±140 Hz away, so
 *    broadband noise (a gunshot, a shout) lifts all three together and never
 *    counts as a beep;
 *  - the tone band is within 12 dB of its own loudest (95th percentile) over
 *    the last minute, so a phone held at a TV, 30 dB quieter than a headset,
 *    still reads, because the threshold follows the level.
 */
import type { ToneRun } from "./decode";

const FRAME_S = 0.005;
/**
 * ⚠️ Each 5 ms frame looks back over 20 ms. A bare 5 ms window has a ~200 Hz
 * main lobe, which swallows the reference bands, so the 15 dB test could
 * never pass; 20 ms under a Hann window resolves them.
 */
const WINDOW_S = 0.02;
const REF_OFFSET_HZ = 140;
const RATIO_DB = 15;
const BELOW_PEAK_DB = 12;
const HISTORY_S = 60;
const PERCENTILE_EVERY = 200; // frames: once a second

const SEARCH = { from: 300, to: 3000, step: 10, window: 2048, everyS: 0.1, peak: 10, votes: 5, share: 0.6 } as const;
/** ⚠️ Kept until the tone locks, then replayed: dropping the first element would shift every digit of the group after it. */
const PRELOCK_MAX_S = 20;

function hann(n: number): Float32Array {
  const w = new Float32Array(n);
  for (let i = 0; i < n; i++) w[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (n - 1));
  return w;
}

export class ToneDetector {
  private readonly rate: number;
  private readonly hop: number;
  private readonly win: number;
  private readonly hannWin: Float32Array;
  private readonly ring: Float32Array;
  private ringIdx = 0;
  private sinceHop = 0;
  private frame = 0;
  private coeffs: [number, number, number] = [0, 0, 0];

  private readonly history: Float32Array;
  private historyLen = 0;
  private historyIdx = 0;
  private threshold = -Infinity;

  private on = false;
  private onFrame = 0;
  private out: ToneRun[] = [];

  private locked: number | null = null;
  private prelock: Float32Array[] = [];
  private prelockLen = 0;
  private dropped = 0;
  private readonly scan: Float32Array;
  private readonly scanHann: Float32Array;
  private scanIdx = 0;
  private sinceScan = 0;
  private votes = new Map<number, number>();
  private totalVotes = 0;

  private lastLevel = 0;

  constructor(sampleRate: number, opts?: { tone?: number }) {
    this.rate = sampleRate;
    this.hop = Math.round(sampleRate * FRAME_S);
    this.win = Math.round(sampleRate * WINDOW_S);
    this.hannWin = hann(this.win);
    this.ring = new Float32Array(this.win);
    this.history = new Float32Array(Math.round(HISTORY_S / FRAME_S));
    this.scan = new Float32Array(SEARCH.window);
    this.scanHann = hann(SEARCH.window);
    if (opts?.tone) this.lock(opts.tone);
  }

  /** The locked tone in Hz, null while still searching. */
  get tone(): number | null {
    return this.locked;
  }

  /** 0..1, the block's loudness, for the meter. */
  get level(): number {
    return this.lastLevel;
  }

  get toneOn(): boolean {
    return this.on;
  }

  /** Runs that ended during this block, in ms since the first sample. */
  push(samples: Float32Array): ToneRun[] {
    let sum = 0;
    for (let i = 0; i < samples.length; i++) sum += samples[i]! * samples[i]!;
    const db = 10 * Math.log10(sum / Math.max(1, samples.length) + 1e-12);
    this.lastLevel = Math.min(1, Math.max(0, (db + 60) / 60));

    this.out = [];
    if (this.locked === null) {
      this.search(samples);
    } else {
      this.frames(samples);
    }
    return this.out;
  }

  private lock(hz: number) {
    this.locked = hz;
    const c = (f: number) => 2 * Math.cos((2 * Math.PI * f) / this.rate);
    this.coeffs = [c(hz), c(hz - REF_OFFSET_HZ), c(hz + REF_OFFSET_HZ)];
  }

  private search(samples: Float32Array) {
    this.prelock.push(samples.slice());
    this.prelockLen += samples.length;
    while (this.prelockLen - this.prelock[0]!.length > PRELOCK_MAX_S * this.rate) {
      const old = this.prelock.shift()!;
      this.prelockLen -= old.length;
      this.dropped += old.length;
    }
    for (let i = 0; i < samples.length; i++) {
      this.scan[this.scanIdx] = samples[i]!;
      this.scanIdx = (this.scanIdx + 1) % SEARCH.window;
      if (++this.sinceScan >= SEARCH.everyS * this.rate) {
        this.sinceScan = 0;
        this.scanOnce();
        if (this.locked !== null) break;
      }
    }
    if (this.locked === null) return;
    // Replay everything heard so far through the run detector, timed from
    // the start of listening.
    this.frame = Math.floor(this.dropped / this.hop);
    const kept = this.prelock;
    this.prelock = [];
    this.prelockLen = 0;
    for (const block of kept) this.frames(block);
  }

  /** One look over 300–3000 Hz; a clear peak is a vote for its frequency. */
  private scanOnce() {
    const bins = Math.floor((SEARCH.to - SEARCH.from) / SEARCH.step) + 1;
    const power = new Float64Array(bins);
    let best = 0;
    for (let b = 0; b < bins; b++) {
      const coeff = 2 * Math.cos((2 * Math.PI * (SEARCH.from + b * SEARCH.step)) / this.rate);
      let s1 = 0;
      let s2 = 0;
      for (let j = 0; j < SEARCH.window; j++) {
        const s = this.scan[(this.scanIdx + j) % SEARCH.window]! * this.scanHann[j]! + coeff * s1 - s2;
        s2 = s1;
        s1 = s;
      }
      power[b] = s1 * s1 + s2 * s2 - coeff * s1 * s2;
      if (power[b]! > power[best]!) best = b;
    }
    const sorted = Float64Array.from(power).sort();
    const median = sorted[Math.floor(bins / 2)]!;
    if (!(power[best]! > SEARCH.peak * median)) return;
    this.votes.set(best, (this.votes.get(best) ?? 0) + 1);
    this.totalVotes++;
    // A bin and its two neighbours are one tone: the window cannot split them.
    let lead = -1;
    let leadVotes = 0;
    for (const b of this.votes.keys()) {
      const v = (this.votes.get(b - 1) ?? 0) + this.votes.get(b)! + (this.votes.get(b + 1) ?? 0);
      if (v > leadVotes) [lead, leadVotes] = [b, v];
    }
    if (leadVotes >= SEARCH.votes && leadVotes >= SEARCH.share * this.totalVotes) {
      let w = 0;
      let f = 0;
      for (const b of [lead - 1, lead, lead + 1]) {
        const v = this.votes.get(b) ?? 0;
        w += v;
        f += v * (SEARCH.from + b * SEARCH.step);
      }
      this.lock(f / w);
    }
  }

  private frames(samples: Float32Array) {
    for (let i = 0; i < samples.length; i++) {
      this.ring[this.ringIdx] = samples[i]!;
      this.ringIdx = (this.ringIdx + 1) % this.win;
      if (++this.sinceHop >= this.hop) {
        this.sinceHop = 0;
        this.decide();
        this.frame++;
      }
    }
  }

  private decide() {
    const [c0, c1, c2] = this.coeffs;
    let a1 = 0, a2 = 0, b1 = 0, b2 = 0, d1 = 0, d2 = 0;
    for (let j = 0; j < this.win; j++) {
      const x = this.ring[(this.ringIdx + j) % this.win]! * this.hannWin[j]!;
      const a = x + c0 * a1 - a2; a2 = a1; a1 = a;
      const b = x + c1 * b1 - b2; b2 = b1; b1 = b;
      const d = x + c2 * d1 - d2; d2 = d1; d1 = d;
    }
    const tone = a1 * a1 + a2 * a2 - c0 * a1 * a2;
    const ref = (b1 * b1 + b2 * b2 - c1 * b1 * b2 + d1 * d1 + d2 * d2 - c2 * d1 * d2) / 2;
    const toneDb = 10 * Math.log10(tone + 1e-20);
    const refDb = 10 * Math.log10(ref + 1e-20);

    this.history[this.historyIdx] = toneDb;
    this.historyIdx = (this.historyIdx + 1) % this.history.length;
    this.historyLen = Math.min(this.historyLen + 1, this.history.length);
    if (this.frame % PERCENTILE_EVERY === 0) {
      const sorted = this.history.slice(0, this.historyLen).sort();
      this.threshold = sorted[Math.floor(sorted.length * 0.95)]! - BELOW_PEAK_DB;
    }

    const on = toneDb - refDb > RATIO_DB && toneDb > this.threshold;
    const ms = (f: number) => ((f * this.hop) / this.rate) * 1000;
    if (on && !this.on) this.onFrame = this.frame;
    if (!on && this.on) this.out.push({ start: ms(this.onFrame), length: ms(this.frame) - ms(this.onFrame) });
    this.on = on;
  }
}
