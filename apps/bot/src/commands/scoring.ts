import { SlashCommandBuilder } from "discord.js";
import type { WarLogFilter } from "@factions/roster";
import { alphasEmbed, scoreboardEmbed, seasonsEmbed, warLogEmbed } from "./embeds/scoring.js";
import type { AutocompleteSource, CommandGroup, Handler } from "./types.js";

/** How many war-log rows fit one card comfortably. The site paginates; Discord shows the newest. */
const WAR_LOG_LIMIT = 25;

const scoreboard: Handler = async (ctx) =>
  ({ embeds: [scoreboardEmbed(await ctx.roster.scoreboard(), ctx.siteBaseUrl)], ephemeral: true });

const alphas: Handler = async (ctx) =>
  ({ embeds: [alphasEmbed(await ctx.roster.alphas(), ctx.siteBaseUrl)], ephemeral: true });

const seasons: Handler = async (ctx) =>
  ({ embeds: [seasonsEmbed(await ctx.roster.seasons(), ctx.siteBaseUrl)], ephemeral: true });

/** ⚠️ The filter goes to the roster; nothing is fetched wide and narrowed here. */
const warlog: Handler = async (ctx, input) => {
  const clanTag = input.string("clan");
  const kind = input.string("kind");
  const filter: WarLogFilter = {
    ...(clanTag ? { clanTag } : {}),
    ...(kind === "raid" || kind === "defense" ? { kind } : {}),
  };
  return { embeds: [warLogEmbed(await ctx.roster.warLog(WAR_LOG_LIMIT, filter), ctx.siteBaseUrl)], ephemeral: true };
};

/** Shared with nothing else: `/clans` has its own, which also offers "recruiting". */
const clanTags: AutocompleteSource = async (ctx, a) => {
  const { clans } = await ctx.roster.directory();
  const q = a.value.trim().toLowerCase();
  return clans
    .filter((c) => q === "" || c.tag.toLowerCase().includes(q) || c.name.toLowerCase().includes(q))
    .map((c) => ({ name: `${c.name} [${c.tag}]`, value: c.tag }));
};

const flat = (name: string, description: string, handler: Handler): CommandGroup => ({
  command: new SlashCommandBuilder().setName(name).setDescription(description),
  specs: [{ path: name, handler }],
});

export const scoreboardGroup = flat("scoreboard", "The open season's table", scoreboard);
export const alphasGroup = flat("alphas", "Closed weeks of the open season", alphas);
export const seasonsGroup = flat("seasons", "Closed seasons and their champions", seasons);

export const warlogGroup: CommandGroup = {
  command: new SlashCommandBuilder()
    .setName("warlog")
    .setDescription("Recent raids and defenses")
    .addStringOption((o) => o.setName("clan").setDescription("Only this clan").setAutocomplete(true))
    .addStringOption((o) => o.setName("kind").setDescription("Only raids, or only defenses")
      .addChoices({ name: "Raids", value: "raid" }, { name: "Defenses", value: "defense" })),
  specs: [{ path: "warlog", handler: warlog, autocomplete: { clan: clanTags } }],
};
