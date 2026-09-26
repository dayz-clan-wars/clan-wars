import { eq, sql } from "drizzle-orm";
import { showEpisodes, type Database } from "@factions/db";
import type { ShowStage } from "@factions/domain";
import { seasonForWeek } from "../story/season.js";
import { episodeNumber } from "../weeks.js";

export type EpisodeRow = typeof showEpisodes.$inferSelect;
export type EpisodeFields = Partial<Omit<EpisodeRow, "weekStart" | "seasonId" | "seasonNumber" | "episodeNumber" | "createdAt">>;

/** Stages a run never leaves on its own: `held` and `rejected` wait for an operator (spec §8.2). */
export const TERMINAL_STAGES: readonly ShowStage[] = ["done", "held", "rejected"];

export async function getEpisode(db: Database, weekStart: Date): Promise<EpisodeRow | null> {
  const [r] = await db.select().from(showEpisodes).where(eq(showEpisodes.weekStart, weekStart));
  return r ?? null;
}

/** The `new` stage (spec §8.2): S and E are frozen here and never recomputed. Idempotent. */
export async function createEpisode(db: Database, weekStart: Date): Promise<EpisodeRow> {
  const season = await seasonForWeek(db, weekStart);
  await db.insert(showEpisodes).values({
    weekStart, seasonId: season.id, seasonNumber: season.number,
    episodeNumber: episodeNumber(season.startedAt, weekStart), stage: "new",
  }).onConflictDoNothing();
  return (await getEpisode(db, weekStart))!;
}

async function write(db: Database, weekStart: Date, set: Record<string, unknown>): Promise<EpisodeRow> {
  const [r] = await db.update(showEpisodes).set({ ...set, updatedAt: new Date() }).where(eq(showEpisodes.weekStart, weekStart)).returning();
  if (!r) throw new Error(`no show_episodes row for ${weekStart.toISOString()}`);
  return r;
}

/** A stage finished: record it, with what it wrote, and start the next stage's failure count at 0. */
export function advance(db: Database, weekStart: Date, stage: ShowStage, fields: EpisodeFields = {}): Promise<EpisodeRow> {
  return write(db, weekStart, { attempts: 0, lastError: null, ...fields, stage });
}

/** Mid-stage progress (an id written right after its post), without finishing the stage. */
export function setFields(db: Database, weekStart: Date, fields: EpisodeFields): Promise<EpisodeRow> {
  return write(db, weekStart, fields);
}

/** Returns the new attempt count at the current stage. */
export async function recordFailure(db: Database, weekStart: Date, error: string): Promise<number> {
  const r = await write(db, weekStart, { attempts: sql`${showEpisodes.attempts} + 1`, lastError: error.slice(0, 2000) });
  return r.attempts;
}

export type ForceResult = "reset" | "missing" | "public-needs-repost";

/**
 * `--force` (spec §10): back to `new`, so the next run rebuilds the context (an operator's new
 * override applies) and writes a new script. ⚠️ A public episode needs `--repost`, which also
 * clears the forum and Facebook ids so the new cut is posted rather than silently skipped.
 * The old unlisted or public YouTube video is left where it is.
 */
export async function forceWeek(db: Database, weekStart: Date, opts: { repost: boolean }): Promise<ForceResult> {
  const row = await getEpisode(db, weekStart);
  if (!row) return "missing";
  if (row.youtubePublicAt !== null && !opts.repost) return "public-needs-repost";
  const cleared: EpisodeFields = {
    context: null, narrative: null, storylines: null, title: null, screeningReport: null,
    youtubeVideoId: null, draftMessageId: null, approvedByDiscordId: null, approvedAt: null,
    rejectedByDiscordId: null, rejectedAt: null, youtubePublicAt: null,
    forumThreadId: null, discordPostedAt: null, facebookVideoId: null, facebookPostedAt: null,
  };
  await db.update(showEpisodes).set({ ...cleared, stage: "new", attempts: 0, lastError: null, updatedAt: new Date() })
    .where(eq(showEpisodes.weekStart, weekStart));
  return "reset";
}
