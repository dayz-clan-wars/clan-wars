import { EmbedBuilder } from "discord.js";
import type { ClaimContext } from "@factions/roster";
import { when } from "@factions/copy";
import type { Draft } from "../founding-draft.js";

const GOLD = 0xc8a34a;

/** `/found`'s in-progress card: who was there, what's chosen so far, and when the ceremony expires. */
export function foundEmbed(c: NonNullable<ClaimContext>, draft: Draft, siteBaseUrl: string): EmbedBuilder {
  return new EmbedBuilder()
    .setColor(GOLD)
    .setTitle("Founding ceremony")
    .setURL(`${siteBaseUrl}/clan`)
    .addFields(
      { name: "Participants", value: c.ceremony.participants.map((p) => `• ${p.gamertag}`).join("\n"), inline: false },
      { name: "Flag", value: draft.texture ?? "not chosen yet", inline: true },
      { name: "Crew", value: String(draft.memberDayzIds.length), inline: true },
      { name: "Expires", value: when(c.ceremony.expiresAt), inline: true },
    );
}
