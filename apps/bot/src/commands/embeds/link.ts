import { EmbedBuilder } from "discord.js";
import type { LinkStatus } from "@factions/roster";
import { ENDED_COPY, formatRemaining } from "@factions/copy";

/** The site's ink. Kept here rather than per-embed so every card matches. */
const GOLD = 0xc8a34a;

/**
 * `/link status` — the card the site's /link page draws, as an embed.
 *
 * ⚠️ The emote sequence IS the secret. It is safe here only because every
 * reply is ephemeral; if this embed ever reaches a public message, anyone
 * reading it can perform the sequence and bind their own UID to this
 * player's account. See `apps/bot/src/commands.ts`.
 */
export function linkStatusEmbed(status: LinkStatus, now: Date, siteBaseUrl: string): EmbedBuilder {
  const embed = new EmbedBuilder().setColor(GOLD).setTitle("Your character");

  if (status.link) {
    embed.setDescription(`Linked to **${status.link.gamertag}**.`);
    embed.addFields({ name: "Unlink", value: "`/link unlink` — refused while you are in a clan.", inline: false });
  } else if (!status.challenge) {
    embed.setDescription("No character linked yet. Run `/link start` and pick your character to draw a challenge.");
  }

  if (status.challenge) {
    const c = status.challenge;
    const steps = c.steps.map((s, n) => `${s.confirmed ? "✅" : `${n + 1}.`} ${s.label}`).join("\n");
    embed.addFields(
      { name: `Challenge for ${c.gamertag}`, value: steps, inline: false },
      { name: "Done", value: `${c.confirmed} of ${c.steps.length}`, inline: true },
      { name: "Expires in", value: formatRemaining(c.expiresAt.getTime() - now.getTime()), inline: true },
      { name: "Redraws left", value: String(c.drawsLeft), inline: true },
    );
    embed.setFooter({ text: "Perform them in order, in game. `/link cancel` drops the challenge." });
  }

  if (status.ended && Object.hasOwn(ENDED_COPY, status.ended)) {
    embed.addFields({ name: "Last attempt", value: ENDED_COPY[status.ended as keyof typeof ENDED_COPY], inline: false });
  }

  embed.setURL(`${siteBaseUrl}/link`);
  return embed;
}
