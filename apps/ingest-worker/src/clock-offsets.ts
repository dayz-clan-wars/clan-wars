/**
 * Per-map server clock offsets used by the historical export replay
 * (`replay-main.ts`). Lives in its own module so the throw below is unit
 * testable without executing the replay entry point.
 *
 * DayZ ADM logs record server-local wall-clock time, not UTC. These offsets were
 * measured against this export's own authoritative ISO timestamps (the export
 * header repeats each line's UTC instant alongside the server-local ADM text),
 * confirming three servers run on three different clocks: `UTC = local + 4h`
 * for Chernarus, `+ 7h` for Livonia and Sakhal. This is measured production data, not a guess —
 * see scripts/backfill.md for the verification query that checks it.
 *
 * ⚠️ These are FIXED offsets, right only for the season they were measured in.
 * `UTC = local + 4h` and `+ 7h` are the offsets of US Eastern and US Pacific
 * DAYLIGHT time, and production server 1 (Pacific) was found to observe DST on
 * 2026-11-01; the "+7h" nasdara entry is PDT, and is an hour wrong for an
 * export recorded in winter. They stay fixed numbers because each replays one
 * historical export already checked against its own UTC stamps — but an
 * export that spans a DST change would be an hour off on one side of it.
 * Live servers take an IANA zone in `servers.time_zone` instead.
 */
export const CLOCK_OFFSET_MS_BY_MAP: Record<string, number> = {
  chernarus: 4 * 60 * 60 * 1000,
  livonia: 7 * 60 * 60 * 1000,
  sakhal: 7 * 60 * 60 * 1000,
  // Measured on the One Life box (same Nitrado box offset, logs UTC-7) on 2026-10-17.
  nasdara: 7 * 60 * 60 * 1000,
};

/**
 * A map missing from CLOCK_OFFSET_MS_BY_MAP must never silently fall back to a
 * zero offset: that is exactly the failure the table exists to prevent (every
 * timestamp for that server stored hours wrong, while every count-based
 * acceptance check stays green). Fail loudly instead.
 */
export function clockOffsetMsFor(map: string): number {
  // Object.hasOwn, not a plain lookup: a bare object literal inherits
  // Object.prototype, so `CLOCK_OFFSET_MS_BY_MAP["constructor"]` would return a
  // function rather than undefined and slip past the guard.
  const offset = Object.hasOwn(CLOCK_OFFSET_MS_BY_MAP, map) ? CLOCK_OFFSET_MS_BY_MAP[map] : undefined;
  if (offset === undefined) {
    const known = Object.keys(CLOCK_OFFSET_MS_BY_MAP).join(", ");
    throw new Error(
      `replay-main: no clockOffsetMs configured for map "${map}" (known maps: ${known})`,
    );
  }
  return offset;
}

