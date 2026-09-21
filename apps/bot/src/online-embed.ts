import type { APIEmbed } from "discord.js";
import { rel } from "@factions/copy";
import { clanLink, playerLink } from "./site-links.js";

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
    const tag = p.tag ? ` ${clanLink(siteBaseUrl, p.tag)}` : "";
    // ⚠️ connectedAt is a DB timestamp and should always be valid, but rel()
    // still guards it — degrade rather than print "on since " with nothing
    // after it.
    const since = rel(p.connectedAt) ?? "an unknown time";
    return `**${playerLink(siteBaseUrl, p.gamertag)}**${tag} · on since ${since}`;
  });
  return {
    title: `Players online · ${players.length}`,
    description: lines.length > 0 ? lines.join("\n") : "Nobody on the server.",
    color: players.length > 0 ? OLIVE : GREY,
    footer: { text: "Last known from the server log · updated" },
    timestamp: now.toISOString(),
  };
}
