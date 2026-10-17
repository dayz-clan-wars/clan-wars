import { AIRDROP_DECIDE_LEAD_MS, AIRDROP_HISTORY_MS, AIRDROP_MIN_GAP_MS, AIRDROP_NO_REPEAT } from "./rules";
import { BUNKER_KINDS, BUNKER_ROOMS, type BunkerKind } from "./bunker";
export { AIRDROP_DECIDE_LEAD_MS, AIRDROP_HISTORY_MS, AIRDROP_MIN_GAP_MS, AIRDROP_NO_REPEAT };

/**
 * What an event places: a bunker room and its template (spec 2026-10-07-bunker-online).
 * `kind` is null only on a row decided before bunkers existed; staging refuses it.
 */
export type AirdropSpec = { location: string; kind: BunkerKind | null };

/**
 * Pick a room and a kind: uniform across the 11 rooms less the last
 * `AIRDROP_NO_REPEAT` used, and 50/50 between the kinds.
 *
 * ⚠️ The fallback to the full list is not defensive padding: a no-repeat window
 * at or above the list's size empties the pool, and an empty pool indexes
 * undefined and throws inside the decision tick.
 */
export function chooseAirdrop(recentLocations: string[], rng: () => number): { location: string; kind: BunkerKind } {
  const recent = new Set(recentLocations.slice(0, AIRDROP_NO_REPEAT));
  const slugs = BUNKER_ROOMS.map((r) => r.slug);
  const pool = slugs.filter((l) => !recent.has(l));
  const from = pool.length > 0 ? pool : slugs;
  const location = from[Math.floor(rng() * from.length)]!;
  const kind = BUNKER_KINDS[Math.floor(rng() * BUNKER_KINDS.length)]!;
  return { location, kind };
}

export type FireInput = {
  /** Players online at the decision instant. */
  pop: number;
  /**
   * The highest decision-instant pop over the trailing `AIRDROP_HISTORY_MS`,
   * EXCLUDING the current instant — `airdrop-tick.ts` builds the sample list with a
   * strict `<`, so `pop` can never be compared against a window containing itself.
   */
  threshold: number;
  minPop: number;
  /** Drops decided this ISO week, `failed` rows excluded — the budget is refunded. */
  weekCount: number;
  weeklyCap: number;
  lastFireAt: Date | null;
  /** Any row still `announced` or `live`. */
  openEvent: boolean;
  now: Date;
};

/** Spec §3.1. All four conditions, in the order that makes a refusal cheapest to read. */
export function shouldFire(i: FireInput): boolean {
  if (i.openEvent) return false;
  if (i.weekCount >= i.weeklyCap) return false;
  if (i.lastFireAt && i.now.getTime() - i.lastFireAt.getTime() < AIRDROP_MIN_GAP_MS) return false;
  return i.pop >= Math.max(i.minPop, i.threshold);
}
