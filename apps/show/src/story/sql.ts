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
