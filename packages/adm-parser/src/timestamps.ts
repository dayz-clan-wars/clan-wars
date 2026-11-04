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
 * How a server's local ADM clock maps onto UTC. One of two, never a default.
 *
 * - `offset`: a single fixed number, `UTC = server-local + offsetMs`. Right for
 *   a clock that never observes daylight saving, and the only form available
 *   when nobody has told us the server's zone.
 * - `zone`: an IANA time zone (`America/Los_Angeles`), converted with the real
 *   zone rules line by line. ⚠️ Required for any server whose clock observes
 *   DST: a fixed offset is right for half the year and an hour wrong for the
 *   other half. Server 1 (US Pacific) stamped three days of events an hour
 *   early after the 2026-11-01 fall-back because it only had an offset.
 */
export type ServerClock =
  | { kind: "offset"; offsetMs: number }
  | { kind: "zone"; timeZone: string };

/**
 * Whether this is a zone name `Intl` (and so this module) can convert in.
 *
 * Offset strings (`+05:00`) are refused although `Intl` accepts them: a fixed
 * offset already has its home in `clock_offset_ms`, and two places to state
 * one fact is how they come to disagree.
 */
export function isValidTimeZone(timeZone: string): boolean {
  if (timeZone.trim() === "" || /^[+-]/u.test(timeZone)) return false;
  try {
    new Intl.DateTimeFormat(undefined, { timeZone });
    return true;
  } catch {
    return false;
  }
}

const formatters = new Map<string, Intl.DateTimeFormat>();

function formatterFor(timeZone: string): Intl.DateTimeFormat {
  let f = formatters.get(timeZone);
  if (!f) {
    // ⚠️ `hourCycle: "h23"`: the default `en-US` cycle can print midnight as
    // "24", which `Date.UTC` would read as the NEXT day's midnight.
    f = new Intl.DateTimeFormat("en-US", {
      timeZone, hourCycle: "h23",
      year: "numeric", month: "2-digit", day: "2-digit",
      hour: "2-digit", minute: "2-digit", second: "2-digit",
    });
    formatters.set(timeZone, f);
  }
  return f;
}

/** The zone's offset at one instant, as `local - UTC` (negative west of Greenwich). */
function zoneOffsetAt(fmt: Intl.DateTimeFormat, utcMs: number): number {
  // Whole seconds: the formatter drops milliseconds, so compare like with like.
  const t = Math.floor(utcMs / 1000) * 1000;
  const parts = fmt.formatToParts(new Date(t));
  const get = (type: Intl.DateTimeFormatPartTypes) => Number(parts.find((p) => p.type === type)!.value);
  const wall = Date.UTC(get("year"), get("month") - 1, get("day"), get("hour"), get("minute"), get("second"));
  return wall - t;
}

/**
 * The fixed-offset equivalent (`UTC = local + offset`) of a zone at one
 * instant — the number the `offset` form would have needed right then. For
 * cross-checks only; converting with it is exactly the bug the zone form fixes.
 */
export function zoneClockOffsetMs(timeZone: string, atUtc: Date): number {
  return -zoneOffsetAt(formatterFor(timeZone), atUtc.getTime());
}

/**
 * How far BEHIND the previous line a first-pass reading of a repeated local
 * hour may land and still be taken as the first pass (write-order jitter).
 *
 * The fall-back steps the local clock back a full hour, so the first-pass
 * reading of a line after the step lands ~1h behind the line before it; a
 * jittered line lands seconds behind. Five minutes sits well between. The
 * case it gets wrong is a server silent for 55+ minutes straddling the
 * step, whose next line lands under five minutes behind on its first-pass
 * reading — it is taken as the first pass, an hour early. Nothing in the log
 * itself can tell those apart.
 */
const REPEAT_JITTER_MS = 5 * 60_000;

/**
 * Turn a local wall-clock reading (components wearing a UTC label, as
 * `parseBootHeader` builds them) into the real instant in `timeZone`.
 *
 * `prevUtcMs` is the instant of the line before in the same file, or null for
 * the first; only the repeated fall-back hour consults it.
 */
function localToUtc(localMs: number, fmt: Intl.DateTimeFormat, prevUtcMs: number | null): number {
  // The real instant is within 14h of `localMs` (no zone is further out), so
  // probing a day either side brackets any transition near it. Assumes no zone
  // changes its offset twice inside 48 hours — none does.
  const before = zoneOffsetAt(fmt, localMs - DAY_MS);
  const after = zoneOffsetAt(fmt, localMs + DAY_MS);
  // A candidate is real only if the zone, at that instant, actually shows
  // `localMs` on the wall.
  const real = [...new Set([before, after])]
    .map((o) => localMs - o)
    .filter((u) => zoneOffsetAt(fmt, u) === localMs - u)
    .sort((a, b) => a - b);

  if (real.length === 1) return real[0]!;

  if (real.length === 0) {
    // ⚠️ The spring-forward gap: this wall time never happened (02:30 on the
    // day Pacific jumps 02:00 → 03:00). A clock that steps correctly never
    // writes one, so the only clock that does is one that has NOT stepped
    // yet — still reading standard time. Its reading means the pre-transition
    // offset, which is also what `Date` and Temporal's "compatible" choose:
    // 02:30 PST = 10:30Z, which reads 03:30 PDT.
    return localMs - before;
  }

  // ⚠️ The fall-back repeat: 01:00–01:59 happens twice (first PDT, then PST,
  // an hour later). The file is in time order, so the first pass is the
  // earlier instant until the clock visibly steps back — at which point the
  // earlier reading would put this line an hour behind the one before it,
  // and only the later instant keeps the file moving forward. Once on the
  // second pass every later repeat reading is likewise an hour behind, so it
  // stays there without any state beyond `prevUtcMs`. A file that BOOTS
  // inside the repeated hour has no line before it and takes the first pass.
  const [earlier, later] = [real[0]!, real[real.length - 1]!];
  if (prevUtcMs !== null && earlier < prevUtcMs - REPEAT_JITTER_MS) return later;
  return earlier;
}

/**
 * One local wall-clock reading (UTC-labelled components) as a real instant in
 * `timeZone`, with no file context: a repeated fall-back hour reads as its
 * first pass, a spring-forward gap as standard time. For cross-checks; ingest
 * goes through `TimelineCursor`, which resolves the repeated hour properly.
 */
export function zoneLocalToUtc(timeZone: string, local: Date): Date {
  return new Date(localToUtc(local.getTime(), formatterFor(timeZone), null));
}

/**
 * Walks one ADM file, turning each line's local HH:MM:SS into an absolute instant.
 *
 * The `bootUtc` parameter is really server-local time wearing a UTC label (built via Date.UTC
 * from the ADM header's components). The cursor keeps its day arithmetic in that local
 * timeline and converts to real UTC only on the way out, per `clock`.
 *
 * A single file can span midnight; the only signal is the clock going backwards, so the
 * cursor rolls the date forward when it detects a backwards jump larger than 12 hours.
 * This threshold separates genuine midnight crossings from transient backwards movements
 * (write-order jitter, and the one-hour DST fall-back, which a `zone` clock then
 * resolves onto the second pass of the repeated hour). Must be fed lines in file order.
 */
export class TimelineCursor {
  #dayStartMs: number;
  #lastMs: number;
  #clock: ServerClock;
  #fmt: Intl.DateTimeFormat | null;
  #lastUtcMs: number | null = null;

  /**
   * ⚠️ `clock` is REQUIRED, deliberately without a default. A default offset
   * of 0 is the silent failure the schema comment on `servers.clock_offset_ms`
   * argues against at length: every row lands, every count-based check stays
   * green, and only the absolute instants are hours wrong. Callers must state
   * the offset or the zone, even when the offset really is zero.
   *
   * Throws on a zone `Intl` does not know, rather than falling back to
   * anything: the worker logs it per tick and ingests nothing for that server
   * until it is corrected, which is loud; a guessed offset would not be.
   */
  constructor(bootUtc: Date, clock: ServerClock) {
    const t = bootUtc.getTime();
    this.#dayStartMs = Math.floor(t / DAY_MS) * DAY_MS;
    this.#lastMs = t;
    this.#clock = clock;
    if (clock.kind === "zone") {
      if (!isValidTimeZone(clock.timeZone)) {
        throw new Error(`TimelineCursor: unknown time zone ${JSON.stringify(clock.timeZone)}`);
      }
      this.#fmt = formatterFor(clock.timeZone);
      // The boot instant anchors the repeated-hour rule for the first line.
      this.#lastUtcMs = localToUtc(t, this.#fmt, null);
    } else {
      this.#fmt = null;
    }
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
    if (this.#clock.kind === "offset") return new Date(ms + this.#clock.offsetMs);

    const utc = localToUtc(ms, this.#fmt!, this.#lastUtcMs);
    this.#lastUtcMs = utc;
    return new Date(utc);
  }
}
