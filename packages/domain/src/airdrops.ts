import {
  AIRDROP_COLOURS, AIRDROP_DECIDE_LEAD_MS, AIRDROP_HISTORY_MS, AIRDROP_LOCATIONS,
  AIRDROP_MIN_GAP_MS, AIRDROP_NO_REPEAT,
} from "./rules";
export {
  AIRDROP_COLOURS, AIRDROP_DECIDE_LEAD_MS, AIRDROP_HISTORY_MS, AIRDROP_LOCATIONS,
  AIRDROP_MIN_GAP_MS, AIRDROP_NO_REPEAT,
};

export type AirdropSpec = { location: string; colour: string };

/**
 * The spawner file a spec names, as `objectSpawnersArr` spells it.
 *
 * ⚠️ Location THEN colour, and the `./custom/` prefix is part of it. The one
 * statement of this fact: `setAirdropSpawner` matches on the `/airdrop-` in it,
 * and a file name assembled a second way somewhere else would register a path the
 * server ignores in silence — no error, no log, no container.
 */
export function airdropSpawnerPath(spec: AirdropSpec): string {
  return `./custom/airdrop-${spec.location}-${spec.colour}.json`;
}

/**
 * Pick a location and a colour (spec §3.3). Uniform across the 16 less the last
 * `AIRDROP_NO_REPEAT` used, and uniform across the three colours.
 *
 * ⚠️ The fallback to the full menu is not defensive padding: a no-repeat window
 * at or above the menu size empties the pool, and an empty pool indexes undefined
 * and throws inside the decision tick.
 */
export function chooseAirdrop(recentLocations: string[], rng: () => number): AirdropSpec {
  const recent = new Set(recentLocations.slice(0, AIRDROP_NO_REPEAT));
  const pool = AIRDROP_LOCATIONS.filter((l) => !recent.has(l));
  const locations: readonly string[] = pool.length > 0 ? pool : AIRDROP_LOCATIONS;
  const location = locations[Math.floor(rng() * locations.length)]!;
  const colour = AIRDROP_COLOURS[Math.floor(rng() * AIRDROP_COLOURS.length)]!;
  return { location, colour };
}

/**
 * The highest of the trailing samples — the bar a drop has to match (spec §3.1,
 * amended 2026-09-21; this replaced a linear-interpolated p90).
 *
 * ⚠️ Computed here rather than with Postgres `max` so the threshold the row records
 * and the threshold the rule applies are one statement, and so this can be tested
 * without a database.
 *
 * ⚠️ `Math.max()` of an empty list is -Infinity, which is why this is not written as
 * the one-liner. No history must return 0, so that `max(AIRDROP_MIN_POP, highWater)`
 * sits at the floor — the correct bar on day one and through the first five days.
 * -Infinity would leave the floor governing too, but it is also written into
 * `airdrop_events.threshold`, and a numeric column does not take it.
 */
export function highWater(values: number[]): number {
  if (values.length === 0) return 0;
  return Math.max(...values);
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

/** Monday 00:00 UTC of `now`'s ISO week. */
export function isoWeekStart(now: Date): Date {
  const utc = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  const backToMonday = (new Date(utc).getUTCDay() + 6) % 7;
  return new Date(utc - backToMonday * 24 * 60 * 60 * 1000);
}

/** The instant a slot's decision is taken: `AIRDROP_DECIDE_LEAD_MS` before it. */
export function decisionInstantFor(slotStart: Date): Date {
  return new Date(slotStart.getTime() - AIRDROP_DECIDE_LEAD_MS);
}
