import { sql } from "drizzle-orm";
import type { Database } from "@factions/db";
import type { PreviousEpisode, Storyline } from "./types.js";
import { rows, tsz } from "./sql.js";

/**
 * Last episode's storylines for "Previously on" (spec §6.5): the latest EARLIER week in
 * the same season whose script exists, whatever happened to it after (awaiting approval,
 * rejected, published). A slow approval must never cost next week its recap.
 */
export async function loadPreviousEpisode(db: Database, seasonId: number, weekStart: Date): Promise<PreviousEpisode | null> {
  const [r] = await rows<{ title: string | null; storylines: Storyline[] | string | null }>(db, sql`
    select title, storylines from show_episodes
    where season_id = ${seasonId} and week_start < ${tsz(weekStart)} and narrative is not null
    order by week_start desc limit 1`);
  if (!r || r.title === null || r.storylines === null) return null;
  const storylines = typeof r.storylines === "string" ? (JSON.parse(r.storylines) as Storyline[]) : r.storylines;
  return { title: r.title, storylines };
}
