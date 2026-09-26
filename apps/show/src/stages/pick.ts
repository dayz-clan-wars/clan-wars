import { sql } from "drizzle-orm";
import type { Database } from "@factions/db";
import { NoSeasonError, seasonForWeek } from "../story/season.js";
import { rows, tsz } from "../story/sql.js";
import { lastEndedWeek, WEEK_MS } from "../weeks.js";
import { TERMINAL_STAGES } from "./store.js";

/** An empty server logs nothing; after this long past week end the show goes out anyway (spec §8.1). */
export const INGEST_GRACE_MS = 6 * 3_600_000;

async function ready(db: Database, weekStart: Date, now: Date): Promise<boolean> {
  let season;
  try {
    season = await seasonForWeek(db, weekStart);
  } catch (e) {
    if (e instanceof NoSeasonError) return false;
    throw e;
  }
  const weekEnd = new Date(weekStart.getTime() + WEEK_MS);
  const [r] = await rows<{ closed: boolean; caught_up: boolean }>(db, sql`
    select
      coalesce((select week_closed_through >= ${tsz(weekStart)} from seasons where id = ${season.id}), false) as closed,
      exists(select 1 from events where server_id = ${season.serverId} and occurred_at >= ${tsz(weekEnd)}) as caught_up`);
  // ⚠️ Both: standings and Alphas must be final (the week close), and ingest must have
  // reached the end of the week, or a late raid is missing from the episode forever.
  return Boolean(r?.closed) && (Boolean(r?.caught_up) || now.getTime() >= weekEnd.getTime() + INGEST_GRACE_MS);
}

/**
 * Spec §8.1: the earliest unfinished row, else the most recent ended week with no row once it
 * is ready. ⚠️ Never an older week with no row: weeks before launch are not backfilled (the
 * runbook seeds one with `--week` if wanted).
 */
export async function pickWeek(db: Database, now: Date): Promise<Date | null> {
  // ⚠️ Read from TERMINAL_STAGES, never hardcoded: two statements of one fact will drift.
  const [open] = await rows<{ week_start: string | Date }>(db, sql`
    select week_start from show_episodes where stage not in (${sql.join(TERMINAL_STAGES.map((s) => sql`${s}`), sql`, `)}) order by week_start asc limit 1`);
  if (open) return new Date(open.week_start);
  const candidate = lastEndedWeek(now);
  const [taken] = await rows<{ one: number }>(db, sql`select 1 as one from show_episodes where week_start = ${tsz(candidate)}`);
  if (taken) return null;
  return (await ready(db, candidate, now)) ? candidate : null;
}
