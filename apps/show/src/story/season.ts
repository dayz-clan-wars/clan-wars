import { sql } from "drizzle-orm";
import type { Database } from "@factions/db";
import { weekWindow } from "../weeks.js";
import { rows, tsz, iso } from "./sql.js";

export class NoSeasonError extends Error {}

/** The season whose run overlaps the week. A wipe week belongs to the season that was open at its start. */
export async function seasonForWeek(db: Database, weekStart: Date): Promise<{ id: number; serverId: number; number: number; startedAt: Date }> {
  const { from, to } = weekWindow(weekStart);
  // ⚠️ Active servers only: a retired server's season still overlaps the calendar, and an
  // earlier start would win the `order by` and put its week on air.
  const [r] = await rows<{ id: number; server_id: number; number: number; started_at: string | Date }>(db, sql`
    select s.id::int as id, s.server_id, s.number, s.started_at from seasons s
    join servers sv on sv.id = s.server_id and sv.active
    where s.started_at < ${tsz(to)} and (s.ended_at is null or s.ended_at > ${tsz(from)})
    order by s.started_at asc limit 1`);
  if (!r) throw new NoSeasonError(`no season covers the week of ${from.toISOString()}`);
  return { id: r.id, serverId: r.server_id, number: r.number, startedAt: new Date(iso(r.started_at)) };
}
