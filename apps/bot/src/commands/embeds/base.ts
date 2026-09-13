import { EmbedBuilder } from "discord.js";
import type { BaseView } from "@factions/roster";
import { DECLARE_COPY, lapsedCopy } from "@factions/copy";

const GOLD = 0xc8a34a;

/**
 * `/base show`.
 *
 * ⚠️ Every coordinate here is the VIEWER's own. `baseFor` never returns
 * another player's pole, because a pole coordinate is a raid target — do not
 * add a field that widens what this card can show.
 */
export function baseEmbed(view: BaseView, siteBaseUrl: string): EmbedBuilder {
  const embed = new EmbedBuilder().setColor(GOLD).setTitle("Your base").setURL(`${siteBaseUrl}/base`);

  if (!view.linked) {
    return embed.setDescription("Link your character first — run `/link start`.");
  }
  if (view.inClan) {
    return embed.setDescription(DECLARE_COPY["in-clan"]);
  }

  if (view.declaration) {
    const d = view.declaration;
    embed.setDescription(`Declared at **${Math.round(d.x)}, ${Math.round(d.z)}**.`);
    embed.addFields({ name: "Release", value: "`/base release`", inline: false });
  } else {
    embed.setDescription("No declared base. Raise your flag at a pole, then run `/base declare`.");
  }

  if (view.lapsed) embed.addFields({ name: "Lapsed", value: lapsedCopy(view.lapsed.at), inline: false });

  if (view.candidates.length > 0) {
    embed.addFields({
      name: "Poles you have raised at",
      value: view.candidates.map((c) => `• ${Math.round(c.x)}, ${Math.round(c.z)}`).join("\n").slice(0, 1024),
      inline: false,
    });
  }
  return embed;
}
