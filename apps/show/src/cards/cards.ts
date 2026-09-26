import type { StoryContext } from "../story/types.js";
import { episodeCode } from "../weeks.js";
import type { Card, CardRow } from "../engine/animation/screenWall.js";
import type { OutroBoard, OutroRow } from "../engine/video/outroBoard.js";
import { isRedactedAlias } from "../engine/audio/redactedSpeech.js";

// Turns a saved StoryContext into the four stat cards, the marquee items and the outro board
// (task-9 brief). Dropped from KOTH: buildMarqueeItems, screenCards and the crown columns are
// replaced by this file (global-context.md §11.2).

const MAX_CARD_ROWS = 5;
const MAX_TOP = 3;
const MAX_OUTRO_ROWS = 5;

/** A name that reached here as a redacted alias (spec §7.3) draws `[REDACTED]`, never the alias itself. */
const name = (s: string): string => (isRedactedAlias(s) ? "[REDACTED]" : s);

// Headers are drawn in the display font, which has no U+00B7 (a "·" there draws nothing), so the
// separator is "|". The outro rows keep "·": they are drawn in Patrick Hand, which has it.
function header(week: StoryContext["week"]): string {
  return `CLAN WARS | ${episodeCode(week.season, week.episode)}`;
}

function weekStandingsCard(ctx: StoryContext): Card {
  const rows: CardRow[] = ctx.clans
    .filter((c) => c.weekPoints > 0)
    .sort((a, b) => b.weekPoints - a.weekPoints)
    .slice(0, MAX_CARD_ROWS)
    .map((c) => ({ name: name(c.tag), value: `${c.weekPoints} pts` }));
  return { header: header(ctx.week), title: "WEEK STANDINGS", rows: rows.length ? rows : [{ name: "NO RAIDS", value: "" }] };
}

function mostKillsCard(ctx: StoryContext): Card {
  const rows: CardRow[] = ctx.players.topKillers.slice(0, MAX_TOP).map((p) => ({ name: name(p.gamertag), value: `${p.value}` }));
  return { header: header(ctx.week), title: "MOST KILLS", rows };
}

function friendlyFireCard(ctx: StoryContext): Card {
  const byKiller = new Map<string, number>();
  for (const pair of ctx.friendlyFire) byKiller.set(pair.killer, (byKiller.get(pair.killer) ?? 0) + pair.count);
  const rows: CardRow[] = [...byKiller.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, MAX_TOP)
    .map(([killer, count]) => ({ name: name(killer), value: `${count}` }));
  return { header: header(ctx.week), title: "FRIENDLY FIRE", rows };
}

function longestShotCard(ctx: StoryContext): Card {
  const rows: CardRow[] = ctx.players.longestShots.slice(0, MAX_TOP).map((s) => ({ name: name(s.gamertag), value: `${Math.round(s.metres)}m` }));
  return { header: header(ctx.week), title: "LONGEST SHOT", rows };
}

/** Exactly 4 cards, in this order: week standings, most kills, friendly fire, longest shot. */
export function buildCards(ctx: StoryContext): Card[] {
  return [weekStandingsCard(ctx), mostKillsCard(ctx), friendlyFireCard(ctx), longestShotCard(ctx)];
}

/**
 * Ordered ticker strings: the site, the Discord invite, then this week's highlights (each
 * omitted when its data is empty/null). As in KOTH `marquee.js`, the fixed labels are written in
 * caps and the invite and every name are drawn exactly as given (invite codes are case-sensitive).
 */
export function buildMarqueeItems(ctx: StoryContext, o: { discordInvite: string }): string[] {
  const items: string[] = ["DAYZCLANWARS.COM", o.discordInvite];
  const topKiller = ctx.players.topKillers[0];
  if (topKiller) items.push(`TOP KILLER: ${name(topKiller.gamertag)} (${topKiller.value})`);
  const longestShot = ctx.players.longestShots[0];
  if (longestShot) items.push(`LONGEST SHOT: ${name(longestShot.gamertag)} ${Math.round(longestShot.metres)}m`);
  if (ctx.week.alpha) items.push(`ALPHA: ${name(ctx.week.alpha.tag)}`);
  return items;
}

/** Top 5 clans by season points (desc, then tag asc), only those with points, "<rank>. <tag>  <n> pts". */
export function buildOutroBoard(ctx: StoryContext): OutroBoard {
  const rows: OutroRow[] = ctx.clans
    .filter((c) => c.seasonPoints > 0)
    .sort((a, b) => b.seasonPoints - a.seasonPoints || a.tag.localeCompare(b.tag))
    .slice(0, MAX_OUTRO_ROWS)
    .map((c) => ({ name: name(c.tag), points: c.seasonPoints, raids: c.seasonRaids }));
  return { headline: `CLAN WARS | SEASON ${ctx.week.season} | AFTER WEEK ${ctx.week.episode}`, rows };
}
