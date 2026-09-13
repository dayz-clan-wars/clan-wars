import { EmbedBuilder } from "discord.js";
import type { Attention, MyInvite, MyRequest, Viewer } from "@factions/roster";

const GOLD = 0xc8a34a;

/**
 * `/me show` — the site's /me page as a card: who you are, and what is
 * waiting on you. The two counts come from `attention`, the same read the
 * site bar uses, so the number here and the number on the site agree.
 */
export function meEmbed(v: Viewer, a: Attention, invites: MyInvite[], requests: MyRequest[], siteBaseUrl: string): EmbedBuilder {
  const embed = new EmbedBuilder().setColor(GOLD).setTitle("You").setURL(`${siteBaseUrl}/me`);

  if (!v.link) {
    return embed.setDescription("No character linked yet. Run `/link start` and pick your character.");
  }
  embed.setDescription(`Playing as **${v.link.gamertag}**.`);

  if (v.clan) embed.addFields({ name: "Clan", value: `**${v.clan.name}** [${v.clan.tag}] — ${v.clan.role}`, inline: false });
  else if (v.pending) embed.addFields({ name: "Clan", value: `Pending at **${v.pending.name}** [${v.pending.tag}] — stand near their base in game.`, inline: false });
  else embed.addFields({ name: "Clan", value: "None. Browse with `/clans list`.", inline: false });

  if (invites.length > 0) {
    embed.addFields({
      name: `Invites (${invites.length})`,
      value: invites.map((i) => `• **${i.clanName}** [${i.tag}] — \`/me accept\` or \`/me decline\``).join("\n").slice(0, 1024),
      inline: false,
    });
  }
  if (requests.length > 0) {
    embed.addFields({
      name: `Your requests (${requests.length})`,
      value: requests.map((r) => `• **${r.clanName}** [${r.tag}] — \`/me withdraw\``).join("\n").slice(0, 1024),
      inline: false,
    });
  }
  if (a.you === 0 && a.clan === 0) embed.setFooter({ text: "Nothing waiting on you." });
  return embed;
}
