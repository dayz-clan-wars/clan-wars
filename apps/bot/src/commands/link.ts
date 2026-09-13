import { SlashCommandBuilder } from "discord.js";
import { linkStatusEmbed } from "./embeds/link.js";
import type { CommandGroup, Handler } from "./types.js";

const status: Handler = async (ctx, input) => ({
  embeds: [linkStatusEmbed(await ctx.roster.linkStatus(input.actorDiscordId), ctx.now, ctx.siteBaseUrl)],
  ephemeral: true,
});

export const linkGroup: CommandGroup = {
  command: new SlashCommandBuilder()
    .setName("link")
    .setDescription("Link your Discord account to your in-game character")
    .addSubcommand((s) => s.setName("status").setDescription("Your link and any open challenge")),
  specs: [{ path: "link status", handler: status }],
};
