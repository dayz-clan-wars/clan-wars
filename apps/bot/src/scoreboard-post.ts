import type { APIEmbed } from "discord.js";
import type { Scoreboard, ScoreboardRow } from "@factions/roster";
import { ALPHA_BADGE, EMPTY_SCOREBOARD } from "@factions/copy";
import type { FlagImageResolver } from "./feed-embed.js";
import { clanUrl, escapeMarkdown } from "./site-links.js";

const GOLD = 0xc8a044;
const GREY = 0x4f545c;

/**
 * Discord's cap on embeds in one message. Past it the post shows the top
 * cards and a "+N more" line that sends people to the site.
 */
export const MAX_CARDS = 10;

/** What the bot sends and edits: the heading line and one card per clan. */
export type ScoreboardPost = { content: string; embeds: APIEmbed[] };

export function scoreboardPageUrl(siteBaseUrl: string): string {
  return `${siteBaseUrl}/scoreboard`;
}

/**
 * The marker the standing post is found by after a restart, in place of a
 * stored message id: the heading's link to the scoreboard page.
 *
 * ⚠️ Matched against the full masked-link form, origin included, so a player
 * message that merely mentions the scoreboard can never be adopted and edited.
 */
export function scoreboardMarker(siteBaseUrl: string): string {
  return `](<${scoreboardPageUrl(siteBaseUrl)}>)`;
}

export function isScoreboardPost(content: string, siteBaseUrl: string): boolean {
  return content.includes(scoreboardMarker(siteBaseUrl));
}

/**
 * Everything a card prints, so the post is edited exactly when it would look
 * different. The "Updated" timestamp is deliberately not in it: keying on the
 * clock would edit the post every pass.
 */
export function scoreboardKey(board: Scoreboard): string {
  if (board.season === null) return "none";
  const rows = board.rows.map((r) =>
    [r.rank ?? "-", r.tag, r.name, r.texture, r.status, r.points, r.raids, r.timesRaided, r.defenses, r.alpha ? 1 : 0].join(":"));
  return `${board.season.number}|${rows.join("|")}`;
}

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

function card(r: ScoreboardRow, siteBaseUrl: string, flagImage: FlagImageResolver): APIEmbed {
  const dormant = r.status === "dormant";
  const badges = [
    r.alpha ? `⭐ ${ALPHA_BADGE}` : null,
    dormant ? "Dormant" : null,
    r.rank === null ? "unranked" : null,
  ].filter((b) => b !== null);
  const first = [`**${plural(r.points, "pt", "pts")}**`, ...badges].join(" · ");
  const counts = `${plural(r.raids, "raid", "raids")} · raided ${plural(r.timesRaided, "time", "times")} · ${plural(r.defenses, "defense", "defenses")}`;
  const thumb = flagImage(r.texture);
  return {
    title: `${r.rank === null ? "—" : `#${r.rank}`} · ${escapeMarkdown(r.name)} [${escapeMarkdown(r.tag)}]`,
    // ⚠️ Every card has its own URL. Discord folds embeds that share a URL
    // into one image gallery, which would merge the cards.
    url: clanUrl(siteBaseUrl, r.tag),
    description: `${first}\n${counts}`,
    color: r.rank !== null && !dormant ? GOLD : GREY,
    ...(thumb ? { thumbnail: { url: thumb } } : {}),
  };
}

/**
 * The #scoreboard post. Pure: no client, no I/O.
 *
 * Same rows, same order and same empty state as the site's /scoreboard page,
 * because it renders the same `scoreboard()` read.
 */
export function scoreboardPost(board: Scoreboard, siteBaseUrl: string, flagImage: FlagImageResolver, now: Date): ScoreboardPost {
  const link = (text: string) => `[${text}](<${scoreboardPageUrl(siteBaseUrl)}>)`;
  const stamp = { footer: { text: "Updated" }, timestamp: now.toISOString() };

  if (board.season === null) {
    return {
      content: `🏆 **${link("Scoreboard")}**`,
      embeds: [{ description: EMPTY_SCOREBOARD, color: GREY, ...stamp }],
    };
  }

  const shown = board.rows.slice(0, MAX_CARDS);
  const hidden = board.rows.length - shown.length;
  const lines = [`🏆 **${link(`Season ${board.season.number} scoreboard`)}**`];
  if (hidden > 0) lines.push(`Top ${MAX_CARDS} of ${board.rows.length}. ${link(`+${hidden} more on the site`)}`);

  if (shown.length === 0) {
    return { content: lines.join("\n"), embeds: [{ description: "No clans yet.", color: GREY, ...stamp }] };
  }
  const embeds = shown.map((r) => card(r, siteBaseUrl, flagImage));
  embeds[embeds.length - 1] = { ...embeds[embeds.length - 1], ...stamp };
  return { content: lines.join("\n"), embeds };
}
