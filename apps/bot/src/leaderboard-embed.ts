import type { APIEmbed } from "discord.js";
import type { BoardKind, Boards, KdRow, LongestKillRow } from "@factions/roster";
import { BOARD_LABELS, BOARD_SLUGS, EMPTY_BOARD, boardValue, scopeLabel } from "@factions/copy";
import { escapeMarkdown } from "./kill-feed-embed.js";
import { clanLink, playerLink } from "./site-links.js";

const GOLD = 0xc8a044;
const GREY = 0x4f545c;

/** Where a board's full page lives, and the marker its standing message is found by. */
export function boardUrl(kind: BoardKind, siteBaseUrl: string): string {
  return `${siteBaseUrl}/players/boards/${BOARD_SLUGS[kind]}`;
}

/**
 * The board an embed's URL names, or null for anything that is not one of our
 * own board links.
 *
 * ⚠️ This is how the tick recognises its nine standing messages after a
 * restart — there is no stored id. The origin is checked, not just the tail:
 * without that, any message quoting a link that merely ENDS in a slug we know
 * would be adopted as ours and then edited.
 */
export function boardKindOfEmbedUrl(url: string | undefined, siteBaseUrl: string): BoardKind | null {
  if (url === undefined) return null;
  for (const kind of Object.keys(BOARD_SLUGS) as BoardKind[]) {
    if (url === boardUrl(kind, siteBaseUrl)) return kind;
  }
  return null;
}

/**
 * What one board must be re-rendered for: its rows, in order, with everything
 * the row actually prints — the number, the name, the clan tag, and a K/D's or
 * a long kill's extra column — plus the scope, which is in the description.
 *
 * ⚠️ The clan tag is in the key on purpose. A row whose player changed clan
 * renders differently while every number stays identical, and without the tag
 * here that message would never be redrawn.
 */
export function leaderboardKey(kind: BoardKind, boards: Boards): string {
  const rows = boards[kind];
  const parts = rows.map((r) => {
    const extra = "kills" in r ? `${r.kills}/${r.deaths}` : "weapon" in r ? (r.weapon ?? "") : "";
    return `${r.dayzId}:${r.value}:${r.gamertag}:${boards.clans[r.dayzId]?.tag ?? ""}:${extra}`;
  });
  return `${scopeLabel(boards.scope)}|${parts.join("|")}`;
}

/** One row, numbered from 1, in the site's own shape: rank, name, clan, extra column, value. */
function line(kind: BoardKind, row: Boards[BoardKind][number], n: number, clanTag: string | undefined, siteBaseUrl: string): string {
  const name = `**${playerLink(siteBaseUrl, row.gamertag)}**`;
  const clan = clanTag ? ` ${clanLink(siteBaseUrl, clanTag)}` : "";
  const kd = row as KdRow;
  const lk = row as LongestKillRow;
  const extra = "kills" in row ? ` · ${kd.kills} / ${kd.deaths}`
    : "weapon" in row && lk.weapon ? ` · ${escapeMarkdown(lk.weapon)}`
    : "";
  return `\`${String(n).padStart(2, " ")}.\` ${name}${clan} — **${boardValue(kind, row.value)}**${extra}`;
}

/**
 * One board's standing message. Pure — no client, no I/O.
 *
 * Titled and ordered exactly as the site's panel is, linked to that board's
 * own page, and labelled with the scope it was read at. An empty board is a
 * sentence rather than a blank card, the same as the site.
 */
export function leaderboardEmbed(kind: BoardKind, boards: Boards, siteBaseUrl: string): APIEmbed {
  const rows = boards[kind];
  const heading = scopeLabel(boards.scope);
  const body = rows.length === 0
    ? EMPTY_BOARD
    : rows.map((r, i) => line(kind, r, i + 1, boards.clans[r.dayzId]?.tag, siteBaseUrl)).join("\n");
  return {
    title: BOARD_LABELS[kind],
    url: boardUrl(kind, siteBaseUrl),
    description: `${heading}\n\n${body}`,
    color: rows.length > 0 ? GOLD : GREY,
    footer: { text: "Updated" },
  };
}
