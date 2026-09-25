import { ActionRowBuilder, ButtonBuilder, ButtonStyle } from "discord.js";
import { voteButtonId } from "./commands/confirm.js";

/**
 * The one public message a vote lives in. `discord.ts` builds the real one; tests
 * pass a fake. ⚠️ Mentions must be off in the real one — the message carries a
 * gamertag.
 */
export type KothVoteChannel = {
  post(content: string, voteId: number): Promise<{ channelId: string; messageId: string }>;
  /** `voteId: null` removes the buttons — a closed vote must not look pressable. */
  edit(channelId: string, messageId: string, content: string, voteId: number | null): Promise<void>;
};

export function voteButtons(voteId: number): ActionRowBuilder<ButtonBuilder> {
  return new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId(voteButtonId(voteId, true)).setLabel("Yes").setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId(voteButtonId(voteId, false)).setLabel("No").setStyle(ButtonStyle.Secondary),
  );
}
