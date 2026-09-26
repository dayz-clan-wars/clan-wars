import { sql } from "drizzle-orm";
import type { Database } from "@factions/db";
import { episodeNumber, weekWindow } from "../weeks.js";
import { PlayerTexts } from "./registry.js";
import { rows, tsz } from "./sql.js";
import type { ClanRef, PlayerLine, RaidStory, StoryContext } from "./types.js";
import { seasonForWeek } from "./season.js";
import { clansForWeek } from "./clans.js";
import { raidsForWeek } from "./raids.js";
import { peopleForWeek, friendlyFireForWeek, clanBeefsForWeek } from "./people.js";
import { flagEventsForWeek, memberMovesForWeek, bountiesForWeek, kothForWeek, airdropsForWeek } from "./events.js";
import { loadPreviousEpisode } from "./previous.js";

const PREV_PLAYER_ALIAS = /REDACTED_PLAYER_\d+/gu;
const PREV_CLAN_ALIAS = /REDACTED_CLAN_\d+/gu;
const IS_ALIAS = /^REDACTED_(?:PLAYER|CLAN)_\d+$/u;

/**
 * ⚠️ Last episode's aliases were numbered for last episode. This episode's redaction numbers
 * its own from 1, so a surviving `REDACTED_PLAYER_1` would name two different people in one
 * prompt. Rewritten to prose, they cannot collide and are never screened as gamertags.
 */
export function neutralizeAliases(s: string): string {
  return s.replace(PREV_PLAYER_ALIAS, "a player whose name we cannot say").replace(PREV_CLAN_ALIAS, "a clan we can't name");
}

/** The rank-1 `alpha_weeks` clan for this season and week, or null when none was crowned yet. */
async function alphaForWeek(db: Database, a: { seasonId: number; weekStart: Date; texts: PlayerTexts }): Promise<ClanRef | null> {
  const [r] = await rows<{ name: string; tag: string }>(db, sql`
    select f.name, f.tag from alpha_weeks aw
    join factions f on f.id = aw.faction_id
    where aw.season_id = ${a.seasonId} and aw.week_start = ${tsz(a.weekStart)} and aw.rank = 1`);
  return r ? a.texts.clan(r.name, r.tag) : null;
}

/**
 * How many raids each raider made this week, most first. The model miscounted a player's
 * raids from the raid list (week 1: "GoldSkull588 has two raids" when he had one), so it
 * gets the count ready-made. Built from `raids`, so it can never disagree with it.
 */
function raidsByPlayer(raids: RaidStory[]): PlayerLine[] {
  const by = new Map<string, PlayerLine>();
  for (const r of raids) {
    const cur = by.get(r.raider);
    if (cur) cur.value += 1;
    else by.set(r.raider, { gamertag: r.raider, clan: r.raiderClan, value: 1 });
  }
  return [...by.values()].sort((a, b) => b.value - a.value || a.gamertag.localeCompare(b.gamertag));
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
  const [raids, players, friendlyFire, clanBeefs, flagEvents, memberMoves, bounties, koth, airdrops, lastEpisode, alpha] = await Promise.all([
    raidsForWeek(db, { serverId: season.serverId, weekStart: opts.weekStart, texts }),
    peopleForWeek(db, week),
    friendlyFireForWeek(db, week),
    clanBeefsForWeek(db, week),
    flagEventsForWeek(db, week),
    memberMovesForWeek(db, week),
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
    title: neutralizeAliases(lastEpisode.title),
    storylines: lastEpisode.storylines.map((s) => ({
      title: neutralizeAliases(s.title),
      status: neutralizeAliases(s.status),
      openQuestions: s.openQuestions.map(neutralizeAliases),
      players: s.players.filter((p) => !IS_ALIAS.test(p)).map((p) => texts.gamertag(p)),
      clans: s.clans.filter((c) => !IS_ALIAS.test(c)).map((c) => texts.clanTag(c)),
    })),
  };

  return {
    context: {
      week: { start: from.toISOString(), end: to.toISOString(), season: season.number, episode: episodeNumber(season.startedAt, opts.weekStart), alpha },
      clans, raids, flagEvents, memberMoves, friendlyFire, clanBeefs, players: { ...players, raidsByPlayer: raidsByPlayer(raids) }, bounties, koth, airdrops, previous,
    },
    texts,
  };
}
