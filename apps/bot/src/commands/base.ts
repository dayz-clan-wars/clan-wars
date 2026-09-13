import { SlashCommandBuilder } from "discord.js";
import { DECLARE_COPY, DECLARED_OK, RELEASE_COPY } from "@factions/copy";
import { baseEmbed } from "./embeds/base.js";
import type { AutocompleteSource, CommandGroup, Handler } from "./types.js";

const show: Handler = async (ctx, input) => ({
  embeds: [baseEmbed(await ctx.roster.baseFor(input.actorDiscordId), ctx.siteBaseUrl)],
  ephemeral: true,
});

const declare: Handler = async (ctx, input) => {
  const pole = input.string("pole");
  if (!pole) return { content: "Pick a pole from the list.", ephemeral: true };
  const outcome = await ctx.roster.declareSolo(input.actorDiscordId, pole);
  return { content: outcome.ok ? DECLARED_OK : DECLARE_COPY[outcome.reason], ephemeral: true };
};

const release: Handler = async (ctx, input) => {
  const { released } = await ctx.roster.releaseSolo(input.actorDiscordId);
  return { content: released ? RELEASE_COPY.released : RELEASE_COPY.nothing, ephemeral: true };
};

/**
 * Only poles THIS player raised a flag at, which is exactly what `baseFor`
 * returns and nothing wider — the same guarantee the site's /base page
 * relies on.
 */
const poles: AutocompleteSource = async (ctx, a) => {
  const view = await ctx.roster.baseFor(a.actorDiscordId);
  if (!view.linked) return [];
  return view.candidates
    .filter((c) => a.value.trim() === "" || c.poleKey.includes(a.value.trim()))
    .map((c) => ({ name: `${Math.round(c.x)}, ${Math.round(c.z)}`, value: c.poleKey }));
};

export const baseGroup: CommandGroup = {
  command: new SlashCommandBuilder()
    .setName("base")
    .setDescription("Your solo base")
    .addSubcommand((s) => s.setName("show").setDescription("Your declaration and the poles you have raised at"))
    .addSubcommand((s) => s
      .setName("declare")
      .setDescription("Declare a solo base at a pole you have raised at")
      .addStringOption((o) => o.setName("pole").setDescription("Which pole").setRequired(true).setAutocomplete(true)))
    .addSubcommand((s) => s.setName("release").setDescription("Give up your declared base")),
  specs: [
    { path: "base show", handler: show },
    { path: "base declare", handler: declare, autocomplete: { pole: poles } },
    { path: "base release", handler: release },
  ],
};
