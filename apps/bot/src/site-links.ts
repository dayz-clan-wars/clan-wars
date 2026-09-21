import type { KillFeedSide } from "./kill-feed-embed.js";

/** Discord markdown in a gamertag would restyle the line; a name is text, never markup. */
export function escapeMarkdown(s: string): string {
  return s.replace(/[\\*_~`|[\]()>]/gu, (c) => `\\${c}`);
}

/**
 * ⚠️ BARE URLs. These feed `embed.setURL()` and `embed.thumbnail.url`,
 * which reject `<https://…>` outright. The angle brackets that suppress
 * Discord's OpenGraph unfurl belong to the RENDERERS below, not here —
 * putting them in one place is what stops a call site getting it wrong.
 */
export function profileUrl(siteBaseUrl: string, gamertag: string): string {
  return `${siteBaseUrl}/players/${encodeURIComponent(gamertag)}`;
}

export function clanUrl(siteBaseUrl: string, tag: string): string {
  return `${siteBaseUrl}/clans/${encodeURIComponent(tag)}`;
}

/**
 * ⚠️ `[text](<url>)` — the angle brackets are load-bearing, not styling.
 * Without them Discord unfurls an OpenGraph preview card beneath the
 * message, which would put a site card under every war-log line. Verified
 * live 2026-09-21; `flags: 4` (SUPPRESS_EMBEDS) also works but suppresses
 * embeds we send ourselves, so it is not usable here.
 */
export function playerLink(siteBaseUrl: string, gamertag: string): string {
  return `[${escapeMarkdown(gamertag)}](<${profileUrl(siteBaseUrl, gamertag)}>)`;
}

/**
 * With a name: `**[Name](<url>)** [TAG]` — the house form, bold actor plus
 * plain tag. Without one: the linked tag alone, for the tag that sits
 * beside an already-linked gamertag in the feeds.
 */
export function clanLink(siteBaseUrl: string, tag: string, name?: string): string {
  const url = clanUrl(siteBaseUrl, tag);
  if (name === undefined) return `[${escapeMarkdown(tag)}](<${url}>)`;
  return `**[${escapeMarkdown(name)}](<${url}>)** [${escapeMarkdown(tag)}]`;
}

/** `[Name](<profile>)` in bold, then the clan tag — now linked too. */
export function who(side: KillFeedSide, siteBaseUrl: string): string {
  const name = `**${playerLink(siteBaseUrl, side.gamertag)}**`;
  return side.tag ? `${name} [${clanLink(siteBaseUrl, side.tag)}]` : name;
}
