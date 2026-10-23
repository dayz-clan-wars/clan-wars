/**
 * Microphone samples in, tone runs out (lib/radio/decode.ts reads them).
 *
 * Pure: no Web Audio here, so vitest drives it with synthetic audio. The
 * browser side (capture.ts) only hands it blocks of samples.
 *
 * Tone-on is two tests, both needed:
 *  - the tone band stands 8 dB above two reference bands ±140 Hz away, so
 *    broadband noise (a gunshot, a shout) lifts all three together and never
 *    counts as a beep. ⚠️ Not more: in real game audio, footsteps and wind
 *    fill a reference band for a moment mid-beep, and at 15 dB the beep broke
 *    up and no group read;
 *  - the tone band is within 12 dB of its own loudest (95th percentile) over
 *    the last minute, so a phone held at a TV, 30 dB quieter than a headset,
 *    still reads, because the threshold follows the level. It also stands
 *    6 dB over the band's median, its noise floor (the radio beeps a quarter
 *    of the time): before the first beep is in the history, the 95th
 *    percentile is the noise itself.
 *
 * Either way it flips only once the new state has held: 40 ms to start a
 * beep, 100 ms to end one. The shortest beep is 75 ms and the shortest gap
 * 400 ms, so a click, or a dropout inside a dash, never reaches the decoder,
 * and a dash never comes out as dots.
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
const RATIO_DB = 8;
/** Frames (5 ms) a new state must hold before it counts; the run is timed from its first frame. */
const ON_FRAMES = 8;
const OFF_FRAMES = 20;
const BELOW_PEAK_DB = 12;
const OVER_FLOOR_DB = 6;
const HISTORY_S = 60;
const PERCENTILE_EVERY = 200; // frames: once a second
/** The longest beep is under half a second. A tone held this long is a hum or a whistle, not the radio: search again. */
const NOT_MORSE_MS = 3000;

const SEARCH = { from: 300, to: 3000, step: 10, window: 2048, everyS: 0.1, peak: 10, votes: 5, lead: 3, floorScans: 20, rise: 10 } as const;
/** ⚠️ Recent audio is kept and replayed once the tone locks: dropping the first element would shift every digit of the group after it. */
const RECENT_MAX_S = 20;

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
  /** Absolute index of the next sample the run path reads. */
  private runSample = 0;
  private coeffs: [number, number, number] = [0, 0, 0];

  private readonly history: Float32Array;
  private historyLen = 0;
  private historyIdx = 0;
  private threshold = -Infinity;
  private hops = 0;

  private on = false;
  private onMs = 0;
  /** Frames in a row that disagree with `on`, and when the first of them was. */
  private pending = 0;
  private flipMs = 0;
  /** When the tone band last began standing clear of its neighbours, whatever its level; null while it does not. */
  private clearSince: number | null = null;
  private out: ToneRun[] = [];

  private locked: number | null = null;
  private gen = 0;
  private from = 0;
  /** Every sample pushed or skipped. */
  private total = 0;
  private recent: Float32Array[] = [];
  private recentLen = 0;
  private recentStart = 0;

  private readonly scan: Float32Array;
  private readonly scanHann: Float32Array;
  private scanIdx = 0;
  private sinceScan = 0;
  private scanPowers: Float64Array[] = [];
  private votes = new Map<number, number>();
  /** Per bin, the sum of each vote's dB over the spectrum's median, less the 10 dB a vote needs. */
  private strength = new Map<number, number>();

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
    if (opts?.tone) this.lock(opts.tone, 0);
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

  /**
   * The first ms of audio the current lock analysed. Silence before it was
   * never heard, so it proves no group gap (decode.ts `spellGroups`).
   */
  get heardFrom(): number {
    return this.from;
  }

  /**
   * Bumped on every lock. ⚠️ Runs from an earlier generation came from a
   * different tone and the replay re-reads the recent audio, so a caller
   * drops the runs it holds when this changes.
   */
  get generation(): number {
    return this.gen;
  }

  /** Runs that ended during this block, in ms since the first sample. */
  push(samples: Float32Array): ToneRun[] {
    let sum = 0;
    for (let i = 0; i < samples.length; i++) sum += samples[i]! * samples[i]!;
    const db = 10 * Math.log10(sum / Math.max(1, samples.length) + 1e-12);
    this.lastLevel = Math.min(1, Math.max(0, (db + 60) / 60));

    this.out = [];
    this.remember(samples);
    this.total += samples.length;
    if (this.locked === null) this.search(samples);
    else this.frames(samples);
    return this.out;
  }

  /**
   * Time that passed with no audio (a suspended or interrupted context): it
   * is silence, not a join. ⚠️ Without it the audio either side of a pause
   * runs together and the decoder reads two halves of different groups as one.
   */
  skip(ms: number): ToneRun[] {
    this.out = [];
    const n = Math.round((ms / 1000) * this.rate);
    if (this.on) this.out.push({ start: this.onMs, length: this.ms(this.runSample) - this.onMs });
    this.on = false;
    this.pending = 0;
    this.clearSince = null;
    this.total += n;
    this.runSample = this.total;
    this.ring.fill(0);
    this.sinceHop = 0;
    // Recent audio no longer runs up to now; a replay across the gap would misplace it.
    this.recent = [];
    this.recentLen = 0;
    this.recentStart = this.total;
    if (this.locked === null) this.from = this.ms(this.total);
    return this.out;
  }

  private ms(sample: number) {
    return (sample / this.rate) * 1000;
  }

  private remember(samples: Float32Array) {
    this.recent.push(samples.slice());
    this.recentLen += samples.length;
    while (this.recentLen - this.recent[0]!.length > RECENT_MAX_S * this.rate) {
      const old = this.recent.shift()!;
      this.recentLen -= old.length;
      this.recentStart += old.length;
    }
  }

  private lock(hz: number, fromSample: number) {
    this.locked = hz;
    this.gen++;
    const c = (f: number) => 2 * Math.cos((2 * Math.PI * f) / this.rate);
    this.coeffs = [c(hz), c(hz - REF_OFFSET_HZ), c(hz + REF_OFFSET_HZ)];
    this.from = this.ms(fromSample);
    this.runSample = fromSample;
    this.ring.fill(0);
    this.sinceHop = 0;
    this.on = false;
    this.pending = 0;
    this.clearSince = null;
    this.historyLen = 0;
    this.historyIdx = 0;
    this.threshold = -Infinity;
    this.hops = 0;
  }

  private unlock() {
    this.locked = null;
    this.on = false;
    this.votes.clear();
    this.strength.clear();
    this.scanPowers = [];
  }

  private search(samples: Float32Array) {
    for (let i = 0; i < samples.length; i++) {
      this.scan[this.scanIdx] = samples[i]!;
      this.scanIdx = (this.scanIdx + 1) % SEARCH.window;
      if (++this.sinceScan >= SEARCH.everyS * this.rate) {
        this.sinceScan = 0;
        const hz = this.scanOnce();
        if (hz !== null) {
          // Replay everything kept, timed from where it began.
          this.lock(hz, this.recentStart);
          for (const block of this.recent) this.frames(block);
          return;
        }
      }
    }
  }

  /**
   * One look over 300–3000 Hz. A clear peak that was much quieter within the
   * last two seconds is a vote for its frequency: the radio switches on and
   * off, a hum, a fan or a TV whine does not, and must never win the lock.
   *
   * ⚠️ Votes are weighed by how far the peak stands out. Between beeps, game
   * sounds peak too, somewhere new each time, and outnumber the beep, which
   * is on a quarter of the time; the beep stands 30 dB clear, they 10–20.
   * Counting votes alone, nothing ever won.
   */
  private scanOnce(): number | null {
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
    this.scanPowers.push(power);
    if (this.scanPowers.length > SEARCH.floorScans) this.scanPowers.shift();
    let floor = Infinity;
    for (const p of this.scanPowers) floor = Math.min(floor, p[best]!);

    const median = Float64Array.from(power).sort()[Math.floor(bins / 2)]!;
    if (!(power[best]! > SEARCH.peak * median) || !(power[best]! > SEARCH.rise * floor)) return null;
    this.votes.set(best, (this.votes.get(best) ?? 0) + 1);
    this.strength.set(best, (this.strength.get(best) ?? 0) + 10 * Math.log10(power[best]! / median) - 10);
    // A bin and its two neighbours are one tone: the window cannot split them.
    const near = (m: Map<number, number>, b: number) => (m.get(b - 1) ?? 0) + (m.get(b) ?? 0) + (m.get(b + 1) ?? 0);
    let lead = -1;
    let leadStrength = 0;
    for (const b of this.strength.keys()) {
      const v = near(this.strength, b);
      if (v > leadStrength) [lead, leadStrength] = [b, v];
    }
    let next = 0;
    for (const b of this.strength.keys()) if (Math.abs(b - lead) > 2) next = Math.max(next, near(this.strength, b));
    if (near(this.votes, lead) < SEARCH.votes || leadStrength < SEARCH.lead * next) return null;
    let w = 0;
    let f = 0;
    for (const b of [lead - 1, lead, lead + 1]) {
      const v = this.votes.get(b) ?? 0;
      w += v;
      f += v * (SEARCH.from + b * SEARCH.step);
    }
    return f / w;
  }

  private frames(samples: Float32Array) {
    for (let i = 0; i < samples.length; i++) {
      this.ring[this.ringIdx] = samples[i]!;
      this.ringIdx = (this.ringIdx + 1) % this.win;
      this.runSample++;
      if (++this.sinceHop >= this.hop) {
        this.sinceHop = 0;
        this.decide();
        if (this.locked === null) {
          // Not Morse after all. What is left of this block feeds the search.
          this.search(samples.subarray(i + 1));
          return;
        }
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
    if (this.hops++ % PERCENTILE_EVERY === 0) {
      const sorted = this.history.slice(0, this.historyLen).sort();
      this.threshold = Math.max(sorted[Math.floor(sorted.length * 0.95)]! - BELOW_PEAK_DB, sorted[Math.floor(sorted.length / 2)]! + OVER_FLOOR_DB);
    }

    const now = this.ms(this.runSample);
    const clear = toneDb - refDb > RATIO_DB;
    const on = clear && toneDb > this.threshold;
    if (on === this.on) this.pending = 0;
    else if (++this.pending === 1) this.flipMs = now;
    if (this.pending >= (on ? ON_FRAMES : OFF_FRAMES)) {
      this.pending = 0;
      if (on) this.onMs = this.flipMs;
      else this.out.push({ start: this.onMs, length: this.flipMs - this.onMs });
      this.on = on;
    }
    // ⚠️ Judged on the band standing clear, not on `on`: a steady hum sits at
    // its own median, under the threshold, so it never reads as a beep and
    // would hold the lock forever.
    if (!clear) this.clearSince = null;
    else if (this.clearSince === null) this.clearSince = now;
    else if (now - this.clearSince > NOT_MORSE_MS) this.unlock();
  }
}
