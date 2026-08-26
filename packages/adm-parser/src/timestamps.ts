const BOOT_RE = /AdminLog started on (\d{4})-(\d{2})-(\d{2}) at (\d{2}):(\d{2}):(\d{2})/u;
const LOCAL_TIME_RE = /(?:^|\|)\s*(\d{2}):(\d{2}):(\d{2})\s*\|/u;

const DAY_MS = 86_400_000;
const ROLLOVER_THRESHOLD_MS = 12 * 60 * 60 * 1000;

/** The ADM header names the file's start in server-local time. */
export function parseBootHeader(raw: string): Date | null {
  const m = BOOT_RE.exec(raw);
  if (!m) return null;
  return new Date(
    Date.UTC(
      parseInt(m[1]!, 10), parseInt(m[2]!, 10) - 1, parseInt(m[3]!, 10),
      parseInt(m[4]!, 10), parseInt(m[5]!, 10), parseInt(m[6]!, 10),
    ),
  );
}

export function parseLocalTime(raw: string): { h: number; m: number; s: number } | null {
  const m = LOCAL_TIME_RE.exec(raw);
  if (!m) return null;
  return { h: parseInt(m[1]!, 10), m: parseInt(m[2]!, 10), s: parseInt(m[3]!, 10) };
}

/**
 * Walks one ADM file, turning each line's local HH:MM:SS into an absolute instant.
 *
 * The `bootUtc` parameter is really server-local time wearing a UTC label (built via Date.UTC
 * from the ADM header's components). The `clockOffsetMs` is added only to the returned Date,
 * converting from server-local to absolute UTC: `UTC = server-local + clockOffsetMs`.
 *
 * A single file can span midnight; the only signal is the clock going backwards, so the
 * cursor rolls the date forward when it detects a backwards jump larger than 12 hours.
 * This threshold separates genuine midnight crossings from transient backwards movements
 * (write-order jitter, DST fall-back). Must be fed lines in file order.
 */
export class TimelineCursor {
  #dayStartMs: number;
  #lastMs: number;
  #clockOffsetMs: number;

  constructor(bootUtc: Date, clockOffsetMs: number = 0) {
    const t = bootUtc.getTime();
    this.#dayStartMs = Math.floor(t / DAY_MS) * DAY_MS;
    this.#lastMs = t;
    this.#clockOffsetMs = clockOffsetMs;
  }

  advance(raw: string): Date | null {
    const lt = parseLocalTime(raw);
    if (!lt) return null;

    const offset = (lt.h * 3600 + lt.m * 60 + lt.s) * 1000;
    let ms = this.#dayStartMs + offset;

    if (ms < this.#lastMs && this.#lastMs - ms > ROLLOVER_THRESHOLD_MS) {
      this.#dayStartMs += DAY_MS;
      ms += DAY_MS;
    }

    this.#lastMs = ms;
    return new Date(ms + this.#clockOffsetMs);
  }
}
