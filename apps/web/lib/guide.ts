import { join } from "node:path";

/**
 * The field guide's table of contents — the one statement of chapter order,
 * slugs and titles. The chapters themselves are hand-written HTML fragments in
 * `content/guide/` (the inside of each old page's <article>, minus the chrome
 * the shell in app/guide renders). The guide is the authority over every rule
 * (CLAUDE.md, "Where things live"); until 2026-09-07 it lived in its own repo
 * and `/guide` was a redirect to fieldguide.dayzclanwars.com.
 *
 * ⚠️ `number` is a string because the appendix is "A". Chapter 1's slug is ""
 * so `/guide` and `hrefFor` compose without a special case.
 */
export type Chapter = { slug: string; number: string; title: string; lede: string; file: string };

export const GUIDE_DESCRIPTION =
  "The player's guide to DayZ Clan Wars: how clans are founded, how bases work, how raids score, and what the server can see.";

/** Where the fragments live. Read at build time only: every guide page is statically generated. */
export const CONTENT_DIR = join(process.cwd(), "content", "guide");

export const CHAPTERS: readonly Chapter[] = [
  { slug: "", number: "1", title: "What this is", file: "01-what-this-is.html",
    lede: "Clan Wars is a reputation war. Found a clan at a flagpole, fly one of thirty-three flags, and raid other clans to climb the scoreboard." },
  { slug: "getting-in", number: "2", title: "Getting in", file: "02-getting-in.html",
    lede: "Join the Discord, log in with it, prove you own your gamertag with three emotes. Then everything opens up." },
  { slug: "founding-a-clan", number: "3", title: "Founding a clan", file: "03-founding-a-clan.html",
    lede: "Three linked players, one white flag, ten minutes. Then a name, a tag, and one of the 33 clan flags." },
  { slug: "bases", number: "4", title: "Bases", file: "04-bases.html",
    lede: "Every flagpole is a base. Declare yours and it is private. Every other base on the server is on the map." },
  { slug: "raiding", number: "5", title: "Raiding", file: "05-raiding.html",
    lede: "A raid is simple: someone who is not in the clan lowers the clan's flag at its declared base." },
  { slug: "defending", number: "6", title: "Defending", file: "06-defending.html",
    lede: "Flag down, 24 hours. Raise it and it is a defense. Miss it and you go dormant. Getting raided can never cost you your colors." },
  { slug: "the-scoreboard", number: "7", title: "The scoreboard", file: "07-the-scoreboard.html",
    lede: "Only raids score. The higher the victim, the more it is worth. Weekly Alphas, a season champion, and a stat line for every player." },
  { slug: "running-a-clan", number: "8", title: "Running a clan", file: "08-running-a-clan.html",
    lede: "Ranks, the cap, joining and leaving, who leads and how that changes, moving house, and the vault." },
  { slug: "discord", number: "9", title: "Discord", file: "09-discord.html",
    lede: "The bot runs its own server. It announces, it keeps your clan's channel, and it DMs you when something needs you. You manage your clan on the site, not in Discord." },
  { slug: "the-map", number: "10", title: "The map", file: "10-the-map.html",
    lede: "Livonia, full screen, built for a phone. What you see depends on who you are, and every layer is a switch." },
  { slug: "getting-around", number: "11", title: "Getting around", file: "11-getting-around.html",
    lede: "Livonia is big. You no longer have to walk it. Stand at a travel point, relog, pick a door." },
  { slug: "fair-play", number: "12", title: "Fair play", file: "12-fair-play.html",
    lede: "Everything else in this guide is enforced by the server log. This chapter is enforced by people." },
  { slug: "rules-on-one-page", number: "13", title: "The rules on one page", file: "13-rules-on-one-page.html",
    lede: "Every promise in this guide, one line each. If it is not here, it is not a rule." },
  { slug: "numbers", number: "A", title: "Every number", file: "numbers.html",
    lede: "Every timer, cap, radius and cooldown, in one table." },
];

export function hrefFor(c: Chapter): string {
  return c.slug ? `/guide/${c.slug}` : "/guide";
}

export function chapterBySlug(slug: string): Chapter | undefined {
  return CHAPTERS.find((c) => c.slug === slug);
}

export function neighbours(c: Chapter): { prev?: Chapter; next?: Chapter } {
  const i = CHAPTERS.indexOf(c);
  return { prev: CHAPTERS[i - 1], next: CHAPTERS[i + 1] };
}
