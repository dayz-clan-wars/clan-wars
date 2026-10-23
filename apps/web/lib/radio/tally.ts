/**
 * Every read heard so far, voted into the three bunkers.
 *
 * The codes hold all night (spec), so every repeat is another vote on the
 * same three messages: a digit drowned out on one pass is heard on the next.
 */
import { isBunkerGrid } from "./bunkers";
import type { Read } from "./decode";

export type DigitState = { value: string | null; agree: number; against: number };
export type BunkerCard = {
  /** Six characters, '?' where unknown. */
  grid: string;
  /** Four characters, '?' where unknown. */
  key: string;
  digits: DigitState[];
  reads: number;
  isBunker: boolean;
  settled: boolean;
};

const CARDS = 3;

function vote(reads: string[]): DigitState[] {
  return Array.from({ length: 10 }, (_, i) => {
    const counts = new Map<string, number>();
    for (const r of reads) if (r[i] !== "?") counts.set(r[i]!, (counts.get(r[i]!) ?? 0) + 1);
    let value: string | null = null;
    let agree = 0;
    for (const [d, n] of counts) if (n > agree) [value, agree] = [d, n];
    const known = [...counts.values()].reduce((a, b) => a + b, 0);
    return { value, agree, against: known - agree };
  });
}

/** Whether `read` is another pass of the message `current` has voted so far. */
function belongs(current: DigitState[], read: string): boolean {
  let same = 0;
  let differ = 0;
  current.forEach((d, i) => {
    if (d.value === null || read[i] === "?") return;
    if (d.value === read[i]) same++;
    else differ++;
  });
  return same >= 4 && differ <= 1;
}

export function tally(reads: Read[]): BunkerCard[] {
  const unknowns = (s: string) => [...s].filter((c) => c === "?").length;
  // Full reads first, so a partial joins a message rather than founding one.
  const ordered = reads.map((r) => r.digits).sort((a, b) => unknowns(a) - unknowns(b));
  const clusters: string[][] = [];
  for (const r of ordered) {
    const home = clusters.find((c) => belongs(vote(c), r));
    if (home) home.push(r);
    else clusters.push([r]);
  }

  return clusters
    .map((c, order) => ({ c, order }))
    // ⚠️ Three messages, all night: a fourth cluster is noise, so it is
    // dropped by having the fewest reads, never shown as a fourth bunker.
    .sort((a, b) => b.c.length - a.c.length || a.order - b.order)
    .slice(0, CARDS)
    .map(({ c }) => {
      const digits = vote(c);
      const text = digits.map((d) => d.value ?? "?").join("");
      const grid = text.slice(0, 6);
      const isBunker = isBunkerGrid(grid);
      return {
        grid,
        key: text.slice(6),
        digits,
        reads: c.length,
        isBunker,
        settled: isBunker && digits.every((d) => d.agree >= 2 && d.against === 0),
      };
    });
}
