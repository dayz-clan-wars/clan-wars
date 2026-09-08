import type { APIEmbed } from "discord.js";
import { escapeMarkdown } from "./kill-feed-embed.js";

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
 * Longest-connected first, each with their clan tag and how long they have
 * been on. Empty is a sentence, not an empty list.
 */
export function onlineEmbed(players: OnlinePlayer[], now: Date): APIEmbed {
  const sorted = [...players].sort((a, b) => a.connectedAt.getTime() - b.connectedAt.getTime() || a.gamertag.localeCompare(b.gamertag));
  const lines = sorted.map((p) => {
    const tag = p.tag ? ` [${escapeMarkdown(p.tag)}]` : "";
    return `**${escapeMarkdown(p.gamertag)}**${tag} · on since <t:${Math.floor(p.connectedAt.getTime() / 1000)}:R>`;
  });
  return {
    title: `Players online · ${players.length}`,
    description: lines.length > 0 ? lines.join("\n") : "Nobody on the server.",
    color: players.length > 0 ? OLIVE : GREY,
    footer: { text: "Last known from the server log · updated" },
    timestamp: now.toISOString(),
  };
}
