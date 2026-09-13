import { EmbedBuilder } from "discord.js";
import type { ClanPage, DirectoryEntry } from "@factions/roster";

const GOLD = 0xc8a34a;

/**
 * `/clans list`. Recruiting first — `directory()` already returns them in
 * that order, so this does not re-sort and cannot disagree with the site.
 *
 * ⚠️ Public data only. `DirectoryEntry` has no base and must never be joined
 * to one here: this card is readable by anyone, including a raider.
 */
export function directoryEmbed(entries: DirectoryEntry[], siteBaseUrl: string): EmbedBuilder {
  const embed = new EmbedBuilder().setColor(GOLD).setTitle("Clans").setURL(`${siteBaseUrl}/clans`);
  if (entries.length === 0) return embed.setDescription("No clans yet.");

  const line = (e: DirectoryEntry) =>
    `• **${e.name}** [${e.tag}] — ${e.memberCount} member${e.memberCount === 1 ? "" : "s"}`
    + (e.alpha ? " · Alpha" : "") + (e.recruiting ? " · Recruiting" : "");

  // One field per 1024-character chunk: Discord rejects a longer field value.
  let chunk: string[] = [];
  let n = 0;
  const flush = () => {
    if (chunk.length === 0) return;
    embed.addFields({ name: n === 0 ? `${entries.length} clans` : "…", value: chunk.join("\n"), inline: false });
    chunk = []; n += 1;
  };
  for (const e of entries) {
    const next = line(e);
    if ([...chunk, next].join("\n").length > 1024) flush();
    chunk.push(next);
  }
  flush();
  embed.setFooter({ text: "`/clans show tag:` for one clan, `/clans join tag:` to ask to join." });
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
      value: page.roster.map((r) => `• ${r.gamertag ?? "—"} — ${r.role}`).join("\n").slice(0, 1024),
      inline: false,
    });
  }
  if (page.canRequest === "yes") embed.setFooter({ text: `Ask to join with /clans join tag: ${page.tag}` });
  return embed;
}
