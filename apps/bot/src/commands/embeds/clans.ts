import { EmbedBuilder } from "discord.js";
import type { ClanPage, DirectoryEntry } from "@factions/roster";
import { budget } from "./budget.js";
import { clanLink, playerLink } from "../../site-links.js";

const GOLD = 0xc8a34a;

/**
 * `/clans list`. Recruiting first — `directory()` already returns them in
 * that order, so this does not re-sort and cannot disagree with the site.
 *
 * ⚠️ Public data only. `DirectoryEntry` has no base and must never be joined
 * to one here: this card is readable by anyone, including a raider.
 */
const FOOTER_TEXT = "`/clans show tag:` for one clan, `/clans join tag:` to ask to join.";
const TITLE = "Clans";

export function directoryEmbed(entries: DirectoryEntry[], siteBaseUrl: string): EmbedBuilder {
  const embed = new EmbedBuilder().setColor(GOLD).setTitle(TITLE).setURL(`${siteBaseUrl}/clans`);
  if (entries.length === 0) return embed.setDescription("No clans yet.");

  const line = (e: DirectoryEntry) =>
    `• ${clanLink(siteBaseUrl, e.tag, e.name)} — ${e.memberCount} member${e.memberCount === 1 ? "" : "s"}`
    + (e.alpha ? " · Alpha" : "") + (e.recruiting ? " · Recruiting" : "");

  budget(TITLE.length + FOOTER_TEXT.length).list(
    embed,
    `${entries.length} clans`,
    entries.map(line),
    (n) => `+${n} more — see the site.`,
  );
  embed.setFooter({ text: FOOTER_TEXT });
  return embed;
}

/** `/clans show` — one clan's public page. Same fields the site shows a stranger. */
export function clanPageEmbed(page: ClanPage, siteBaseUrl: string): EmbedBuilder {
  const embed = new EmbedBuilder()
    .setColor(GOLD)
    .setTitle(`${page.name} [${page.tag}]`)
    .setURL(`${siteBaseUrl}/clans/${page.tag}`)
    .addFields(
      { name: "Members", value: String(page.memberCount), inline: true },
      { name: "Recruiting", value: page.recruiting ? "Yes" : "No", inline: true },
      { name: "Raids / defenses", value: `${page.stats.raids} / ${page.stats.defenses}`, inline: true },
    );
  if (page.pitch) embed.setDescription(page.pitch.slice(0, 2048));
  if (page.playWindow) embed.addFields({ name: "Plays", value: page.playWindow, inline: true });
  if (page.language) embed.addFields({ name: "Language", value: page.language, inline: true });
  if (page.alphaWeeks > 0) embed.addFields({ name: "Alpha weeks", value: String(page.alphaWeeks), inline: true });
  if (page.roster.length > 0) {
    embed.addFields({
      name: "Roster",
      value: page.roster.map((r) => `• ${r.gamertag ? playerLink(siteBaseUrl, r.gamertag) : "—"} — ${r.role}`).join("\n").slice(0, 1024),
      inline: false,
    });
  }
  if (page.canRequest === "yes") embed.setFooter({ text: `Ask to join with /clans join tag: ${page.tag}` });
  return embed;
}
