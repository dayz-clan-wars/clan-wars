import { SlashCommandBuilder } from "discord.js";
import { discordCopy } from "@factions/copy";
import { directoryEmbed, clanPageEmbed } from "./embeds/clans.js";
import type { AutocompleteSource, CommandGroup, Handler } from "./types.js";

/** `/clans list` — every clan, public fields only. */
const list: Handler = async (ctx) => {
  const { clans } = await ctx.roster.directory();
  return { embeds: [directoryEmbed(clans, ctx.siteBaseUrl)], ephemeral: true };
};

/**
 * `/clans show` — one clan's public page.
 *
 * ⚠️ The viewer's own id is passed through so `canRequest` is computed for
 * THEM, not locally guessed at — the roster call is the permission check.
 */
const show: Handler = async (ctx, input) => {
  const tag = input.string("tag");
  const page = tag ? await ctx.roster.clanByTag(tag, input.actorDiscordId) : null;
  if (!page) return { content: discordCopy("request", "no-such-clan"), ephemeral: true };
  return { embeds: [clanPageEmbed(page, ctx.siteBaseUrl)], ephemeral: true };
};

/** `/clans join` — ask to join. `requestJoin` re-derives every refusal; nothing is gated locally. */
const join: Handler = async (ctx, input) => {
  const tag = input.string("tag");
  if (!tag) return { content: "Pick a clan from the list.", ephemeral: true };
  const { outcome } = await ctx.roster.requestJoin(input.actorDiscordId, tag);
  return { content: discordCopy("request", outcome), ephemeral: true };
};

/** Offers tags from the directory, filtered case-insensitively by name or tag. */
const tags: AutocompleteSource = async (ctx, a) => {
  const { clans } = await ctx.roster.directory();
  const q = a.value.trim().toLowerCase();
  return clans
    .filter((c) => q === "" || c.tag.toLowerCase().includes(q) || c.name.toLowerCase().includes(q))
    .map((c) => ({ name: `${c.name} [${c.tag}]${c.recruiting ? " · recruiting" : ""}`, value: c.tag }));
};

export const clansGroup: CommandGroup = {
  command: new SlashCommandBuilder()
    .setName("clans")
    .setDescription("Browse clans and ask to join one")
    .addSubcommand((s) => s.setName("list").setDescription("Every clan"))
    .addSubcommand((s) => s.setName("show").setDescription("One clan's page")
      .addStringOption((o) => o.setName("tag").setDescription("Which clan").setRequired(true).setAutocomplete(true)))
    .addSubcommand((s) => s.setName("join").setDescription("Ask to join a clan")
      .addStringOption((o) => o.setName("tag").setDescription("Which clan").setRequired(true).setAutocomplete(true))),
  specs: [
    { path: "clans list", handler: list },
    { path: "clans show", handler: show, autocomplete: { tag: tags } },
    { path: "clans join", handler: join, autocomplete: { tag: tags } },
  ],
};
