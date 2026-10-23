/**
 * The bunker radio's Morse, from tone runs to digit reads.
 *
 * The broadcast is three groups of ten digits, about 6.8 s apart, repeating
 * all night: six digits of grid, four of key code. It is slow and slotted, so
 * the steadiest thing to read is the time from one element's START to the
 * next one's: gunfire and voice chat stretch or clip a tone's length and the
 * silence after it, but barely move where the next tone begins. Every Morse
 * digit is five elements, so a group is 50 and splits into digits by
 * counting — the gap between digits is usually longer, but not reliably.
 *
 * Pure: no browser API, so the whole decoder runs under vitest against the
 * runs of a real recording (test/fixtures/bunker-radio-runs.json).
 * Spec docs/superpowers/specs/2026-10-23-bunker-radio-decoder-design.md.
 */

/** One stretch of tone, in ms since listening began. */
export type ToneRun = { start: number; length: number };
export type Sym = "." | "-" | "?";
export type Group = {
  start: number;
  symbols: Sym[];
  /** A real group gap of silence was heard before it, so its first element is the group's first. */
  fromStart: boolean;
  /** A real group gap of silence followed it, so its last element is the group's last. */
  toEnd: boolean;
  /** Still coming in: no group gap of silence has followed it yet. */
  open: boolean;
};
/** Always ten characters, '?' where a digit is unknown. */
export type Read = { digits: string };

/** Measured from the recording; the starting values {@link speedScale} adjusts. */
export const TIMING = {
  dot: 90,
  dash: 485,
  pitchDot: 890,
  pitchDash: 1900,
  charExtra: 400,
  groupGap: 4000,
  realGap: 6000,
  isolated: 2500,
  joinGap: 300,
  minRun: 50,
} as const;

const DIGITS: Record<string, string> = {
  "-----": "0", ".----": "1", "..---": "2", "...--": "3", "....-": "4",
  ".....": "5", "-....": "6", "--...": "7", "---..": "8", "----.": "9",
};
const PITCH = { ".": TIMING.pitchDot, "-": TIMING.pitchDash } as const;
const FIT_MS = 300;
const GROUP_LEN = 50;

/**
 * A noise burst chops one tone into pieces a few ms apart; put them back together.
 * ⚠️ Blips are dropped BEFORE joining: two 5 ms noise blips 75 ms apart would
 * otherwise join into an 80 ms "dot", and one phantom element shifts every
 * digit of the group after it.
 */
function joined(runs: ToneRun[]): ToneRun[] {
  const out: ToneRun[] = [];
  for (const r of runs.filter((x) => x.length >= TIMING.minRun).sort((a, b) => a.start - b.start)) {
    const last = out.at(-1);
    if (last && r.start - (last.start + last.length) < TIMING.joinGap) {
      last.length = Math.max(last.length, r.start + r.length - last.start);
    } else {
      out.push({ ...r });
    }
  }
  return out;
}

/** A run with long silence on both sides is a stray noise, not Morse: left in, it would bridge a group gap and merge two groups. */
function withoutStrays(rs: ToneRun[], k: number): ToneRun[] {
  const quiet = TIMING.isolated * k;
  return rs.filter((r, i) => {
    const prev = rs[i - 1];
    const next = rs[i + 1];
    if (!prev || !next) return true;
    return !(r.start - (prev.start + prev.length) > quiet && next.start - (r.start + r.length) > quiet);
  });
}

/**
 * How much slower (> 1) or faster (< 1) this broadcast is than the recording:
 * the median start-to-start of the dashes, over the recording's 1900 ms. The
 * cap at 1.45× leaves out dashes followed by a group gap or a lost element.
 * Fewer than five dashes is too little to judge, so 1.
 */
export function speedScale(runs: ToneRun[]): number {
  const rs = joined(runs);
  const pitches: number[] = [];
  for (let i = 0; i + 1 < rs.length; i++) {
    const p = rs[i + 1]!.start - rs[i]!.start;
    if (rs[i]!.length > 300 && p > TIMING.pitchDash * 0.6 && p < TIMING.pitchDash * 1.45) pitches.push(p);
  }
  if (pitches.length < 5) return 1;
  pitches.sort((a, b) => a - b);
  return pitches[Math.floor(pitches.length / 2)]! / TIMING.pitchDash;
}

function classify(length: number, k: number): Sym {
  if (length < 200 * k) return ".";
  if (length > 300 * k) return "-";
  return "?";
}

const COMBOS: string[][] = [1, 2, 3].map((n) => {
  let out = [""];
  for (let i = 0; i < n; i++) out = out.flatMap((c) => [c + ".", c + "-"]);
  return out;
});

/**
 * The elements between one start and the next: this one plus any drowned out
 * after it, with up to one digit boundary each. Null when nothing fits.
 */
function explain(first: Sym, pitch: number, k: number): Sym[] | null {
  let best: { err: number; syms: Sym[] } | null = null;
  for (const combos of COMBOS) {
    for (const combo of combos) {
      if (first !== "?" && combo[0] !== first) continue;
      const base = [...combo].reduce((t, c) => t + PITCH[c as "." | "-"], 0);
      for (let b = 0; b <= combo.length; b++) {
        const err = Math.abs(pitch - k * (base + b * TIMING.charExtra));
        if (err < FIT_MS * k && (!best || err < best.err)) best = { err, syms: [...combo] as Sym[] };
      }
    }
  }
  return best?.syms ?? null;
}

/**
 * Every group heard so far, spelled out. `now` is ms since listening began;
 * `heardFrom` is the first ms of audio actually analysed (the detector drops
 * audio heard long before the tone locks), so silence before it proves nothing.
 */
export function spellGroups(runs: ToneRun[], now: number, heardFrom = 0): Group[] {
  const k0 = speedScale(runs);
  const rs = withoutStrays(joined(runs), k0);
  if (rs.length === 0) return [];
  const k = speedScale(rs);
  const gap = TIMING.groupGap * k;
  const real = TIMING.realGap * k;

  const raw: ToneRun[][] = [[rs[0]!]];
  for (let i = 1; i < rs.length; i++) {
    const prev = rs[i - 1]!;
    if (rs[i]!.start - (prev.start + prev.length) > gap) raw.push([]);
    raw.at(-1)!.push(rs[i]!);
  }

  return raw.map((g, gi) => {
    const symbols: Sym[] = [];
    for (let i = 0; i + 1 < g.length; i++) {
      symbols.push(...(explain(classify(g[i]!.length, k), g[i + 1]!.start - g[i]!.start, k) ?? ["?" as const]));
    }
    const last = g.at(-1)!;
    symbols.push(classify(last.length, k));
    const before = gi > 0 ? g[0]!.start - (raw[gi - 1]!.at(-1)!.start + raw[gi - 1]!.at(-1)!.length) : g[0]!.start - heardFrom;
    const after = gi < raw.length - 1 ? raw[gi + 1]![0]!.start - (last.start + last.length) : now - (last.start + last.length);
    return {
      start: g[0]!.start,
      symbols,
      // ⚠️ Over 4 s of silence splits a group, but only a real group gap
      // (~6.8 s) proves an end: two drowned dashes leave ~5 s mid-group, and
      // calling the piece after it "from the start" reads it into wrong digits.
      fromStart: before >= real,
      toEnd: after >= real,
      open: gi === raw.length - 1 && after <= gap,
    };
  });
}

/** Five elements at a time, from the left or from the end. A chunk with an unknown element is a digit only if exactly one fits. */
export function toDigits(symbols: Sym[], from: "left" | "right" = "left"): string {
  const n = Math.floor(symbols.length / 5);
  const offset = from === "right" ? symbols.length - n * 5 : 0;
  let out = "";
  for (let i = 0; i < n; i++) {
    const chunk = symbols.slice(offset + i * 5, offset + i * 5 + 5);
    const fits = Object.entries(DIGITS).filter(([code]) => chunk.every((s, j) => s === "?" || s === code[j]));
    out += fits.length === 1 ? fits[0]![1] : "?";
  }
  return out;
}

/**
 * One read per group worth reading, lined up in its ten places. A group heard
 * from its start lines up from the left, one heard to its end from the right.
 * Both ends and exactly 50 elements is a full read. Both ends and any other
 * count means an element was lost or invented somewhere unknown, so a digit is
 * kept only where both alignments agree.
 */
export function readsOf(groups: Group[]): Read[] {
  const reads: Read[] = [];
  for (const g of groups) {
    // Under ten elements is a stray blip or a fragment, not two digits' worth.
    if (g.symbols.length < 10) continue;
    const left = toDigits(g.symbols).slice(0, 10).padEnd(10, "?");
    const right = toDigits(g.symbols, "right").slice(-10).padStart(10, "?");
    if (g.fromStart && g.toEnd) {
      reads.push({ digits: g.symbols.length === GROUP_LEN ? left : [...left].map((c, i) => (c === right[i] ? c : "?")).join("") });
    } else if (g.fromStart) {
      reads.push({ digits: left });
    } else if (g.toEnd) {
      reads.push({ digits: right });
    }
    // ⚠️ Neither end heard (a tail still coming in, or a piece between two
    // dropouts): any alignment is a guess, and a wrong read seeds a wrong
    // cluster in the tally. No read.
  }
  return reads;
}
