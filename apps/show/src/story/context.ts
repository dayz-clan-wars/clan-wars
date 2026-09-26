import { sql } from "drizzle-orm";
import type { Database } from "@factions/db";
import { episodeNumber, weekWindow } from "../weeks.js";
import { PlayerTexts } from "./registry.js";
import { rows, tsz } from "./sql.js";
import type { ClanRef, StoryContext } from "./types.js";
import { seasonForWeek } from "./season.js";
import { clansForWeek } from "./clans.js";
import { raidsForWeek } from "./raids.js";
import { peopleForWeek, friendlyFireForWeek, clanBeefsForWeek } from "./people.js";
import { flagEventsForWeek, bountiesForWeek, kothForWeek, airdropsForWeek } from "./events.js";
import { loadPreviousEpisode } from "./previous.js";

/** The rank-1 `alpha_weeks` clan for this season and week, or null when none was crowned yet. */
async function alphaForWeek(db: Database, a: { seasonId: number; weekStart: Date; texts: PlayerTexts }): Promise<ClanRef | null> {
  const [r] = await rows<{ name: string; tag: string }>(db, sql`
    select f.name, f.tag from alpha_weeks aw
    join factions f on f.id = aw.faction_id
    where aw.season_id = ${a.seasonId} and aw.week_start = ${tsz(a.weekStart)} and aw.rank = 1`);
  return r ? a.texts.clan(r.name, r.tag) : null;
}

/**
 * The week, as the model will read it, plus every player-written string in it
 * (spec §5). Nothing here is screened yet: pass `texts` to `screenTexts` and the
 * result to `redactContext` before any of it reaches a prompt.
 *
 * `previous: null` skips the `show_episodes` lookup, for a database the show's
 * migration has not reached yet (a `--dry-run` against production before release).
 */
export async function buildStoryContext(db: Database, opts: {
  weekStart: Date; staffTags: string[]; previous: "db" | null;
}): Promise<{ context: StoryContext; texts: PlayerTexts }> {
  const season = await seasonForWeek(db, opts.weekStart);
  const { from, to } = weekWindow(opts.weekStart);
  const texts = new PlayerTexts();
  const week = { serverId: season.serverId, from, to, texts };

  const clans = await clansForWeek(db, { serverId: season.serverId, seasonId: season.id, weekStart: opts.weekStart, weekEnd: to, staffTags: opts.staffTags, texts });
  const [raids, players, friendlyFire, clanBeefs, flagEvents, bounties, koth, airdrops, lastEpisode, alpha] = await Promise.all([
    raidsForWeek(db, { serverId: season.serverId, weekStart: opts.weekStart, texts }),
    peopleForWeek(db, week),
    friendlyFireForWeek(db, week),
    clanBeefsForWeek(db, week),
    flagEventsForWeek(db, week),
    bountiesForWeek(db, week),
    kothForWeek(db, week),
    airdropsForWeek(db, week),
    opts.previous === "db" ? loadPreviousEpisode(db, season.id, opts.weekStart) : Promise.resolve(null),
    alphaForWeek(db, { seasonId: season.id, weekStart: opts.weekStart, texts }),
  ]);

  // Last week's names were screened last week, but an operator may have blocked one
  // since. Registering them puts them through this week's screen too, and the context
  // carries the capped form registration returns: exactly what screening sees.
  const previous = lastEpisode === null ? null : {
    ...lastEpisode,
    storylines: lastEpisode.storylines.map((s) => ({
      ...s,
      players: s.players.map((p) => texts.gamertag(p)),
      clans: s.clans.map((c) => texts.clanTag(c)),
    })),
  };

  return {
    context: {
      week: { start: from.toISOString(), end: to.toISOString(), season: season.number, episode: episodeNumber(season.startedAt, opts.weekStart), alpha },
      clans, raids, flagEvents, friendlyFire, clanBeefs, players, bounties, koth, airdrops, previous,
    },
    texts,
  };
}
