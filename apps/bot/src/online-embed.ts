import type { APIEmbed } from "discord.js";
import { onlineLine, ONLINE_TITLE, ONLINE_EMPTY } from "@factions/copy";
import { lineMarkdown } from "./site-links.js";

/** One player the log currently has on the server. */
export type OnlinePlayer = { dayzId: string; gamertag: string; tag: string | null; connectedAt: Date };

const OLIVE = 0x6b8e23;
const GREY = 0x4f545c;

/**
 * What the board must be re-rendered for. Two reads with the same key show
 * the same message; the tick edits nothing between them. `<t:R>` timestamps
 * count on their own inside Discord, so a passing minute is not a change.
 */
export function onlineKey(players: OnlinePlayer[]): string {
  return players.map((p) => `${p.dayzId}@${p.connectedAt.getTime()}:${p.tag ?? ""}`).sort().join("|");
}

/**
 * The one message in #players-online. Pure — no client, no I/O.
 *
 * Longest-connected first, each name linked to their profile on the site,
 * with their clan tag and how long they have been on. Empty is a sentence,
 * not an empty list.
 */
export function onlineEmbed(players: OnlinePlayer[], now: Date, siteBaseUrl: string): APIEmbed {
  const sorted = [...players].sort((a, b) => a.connectedAt.getTime() - b.connectedAt.getTime() || a.gamertag.localeCompare(b.gamertag));
  const lines = sorted.map((p) => {
    // ⚠️ toISOString() throws on an invalid Date. connectedAt should always be
    // valid, but an unparseable string makes onlineLine say "an unknown time".
    const connectedAt = Number.isFinite(p.connectedAt.getTime()) ? p.connectedAt.toISOString() : "invalid";
    return lineMarkdown(onlineLine({ gamertag: p.gamertag, tag: p.tag, connectedAt }), siteBaseUrl);
  });
  return {
    title: ONLINE_TITLE(players.length),
    description: lines.length > 0 ? lines.join("\n") : ONLINE_EMPTY,
    color: players.length > 0 ? OLIVE : GREY,
    footer: { text: "Last known from the server log · updated" },
    timestamp: now.toISOString(),
  };
}
