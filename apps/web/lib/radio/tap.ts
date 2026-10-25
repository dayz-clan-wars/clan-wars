/**
 * Tapping along to the beeps, as tone runs: the same runs the microphone's
 * detector hands over, so the same decoder, vote and bunker check read them.
 *
 * It works by hand because the decoder trusts the time from one element's
 * START to the next, not how long a tone lasted: a player's taps keep the
 * broadcast's rhythm (890 ms after a dot, 1900 ms after a dash) well inside
 * the decoder's 300 ms tolerance, however long or short each press is.
 */
import { TIMING, type ToneRun } from "./decode";

/**
 * ⚠️ A quick tap on glass can last under `TIMING.minRun`, which the decoder
 * drops as a noise blip: one lost element shifts every digit after it. A
 * press is a deliberate element, so it is never shorter than this.
 */
const MIN_PRESS_MS = TIMING.minRun + 10;

export class TapKey {
  readonly runs: ToneRun[] = [];
  private downAt: number | null = null;

  /** `t0` is the clock reading tapping began at (performance.now(), an event's timeStamp). */
  constructor(private readonly t0: number) {}

  press(t: number): void {
    if (this.downAt === null) this.downAt = t - this.t0;
  }

  /** Also the answer to a cancelled pointer or a lost focus: a stuck press would read as one endless dash. */
  release(t: number): void {
    if (this.downAt === null) return;
    this.runs.push({ start: this.downAt, length: Math.max(MIN_PRESS_MS, t - this.t0 - this.downAt) });
    this.downAt = null;
  }

  get pressed(): boolean {
    return this.downAt !== null;
  }

  /** Ms since tapping began, the decoder's `now`. */
  elapsed(t: number): number {
    return t - this.t0;
  }
}
