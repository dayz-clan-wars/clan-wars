import { sql, type SQL } from "drizzle-orm";
import type { Database } from "@factions/db";

/** A raw query's rows. Every story read is one SQL statement; this is the only cast. */
export async function rows<T>(db: Database, q: SQL): Promise<T[]> {
  return (await db.execute(q)) as unknown as T[];
}

/** A Date as a timestamptz parameter. */
export const tsz = (d: Date): SQL => sql`${d.toISOString()}::timestamptz`;

/** ⚠️ A player with no `players` row is named by this, never by their DayZ id (spec §5.2). */
export const UNKNOWN_PLAYER = "an unknown survivor";

/**
 * ⚠️ drizzle's postgres-js driver hands timestamps back as strings, not Dates, on raw
 * `execute`. Accept both so a driver change does not turn every time into "Invalid Date".
 */
export const iso = (v: Date | string): string => (v instanceof Date ? v : new Date(v)).toISOString();

const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const pad2 = (n: number): string => String(n).padStart(2, "0");

/**
 * ⚠️ The model was computing the weekday itself from `at` and getting it wrong (spec
 * §5.2 amendment): it called a Thursday and a Friday both "Wednesday". This precomputes
 * a human label in UTC — the whole project is UTC — so the model never has to. Uses the
 * `Date` object's own UTC getters, never `toLocaleString` or anything else that could
 * read the process's local timezone, so it is correct no matter what `TZ` is set to.
 */
export function whenLabel(v: Date | string): string {
  const d = v instanceof Date ? v : new Date(v);
  return `${WEEKDAYS[d.getUTCDay()]} ${pad2(d.getUTCHours())}:${pad2(d.getUTCMinutes())} UTC`;
}
