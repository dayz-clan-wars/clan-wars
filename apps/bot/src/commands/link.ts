import { SlashCommandBuilder } from "discord.js";
import { ISSUE_COPY, UNLINK_COPY } from "@factions/copy";
import { linkStatusEmbed } from "./embeds/link.js";
import type { AutocompleteSource, CommandGroup, Handler } from "./types.js";

const status: Handler = async (ctx, input) => ({
  embeds: [linkStatusEmbed(await ctx.roster.linkStatus(input.actorDiscordId), ctx.now, ctx.siteBaseUrl)],
  ephemeral: true,
});

/**
 * `/link start` — issue a challenge, then show it.
 *
 * The outcome kinds that MEAN a challenge is open ("issued", "live") are not
 * rendered from the outcome: the status read is the one place that formats a
 * challenge, so the card a player sees here and the card `/link status` shows
 * them a minute later cannot drift apart.
 */
const start: Handler = async (ctx, input) => {
  const target = input.string("character");
  if (!target) return { content: "Pick a character from the list.", ephemeral: true };

  const outcome = await ctx.roster.startLink(input.actorDiscordId, target, { newSequence: input.boolean("redraw") === true });
  if (outcome.kind === "issued" || outcome.kind === "live") {
    return { embeds: [linkStatusEmbed(await ctx.roster.linkStatus(input.actorDiscordId), ctx.now, ctx.siteBaseUrl)], ephemeral: true };
  }
  return { content: ISSUE_COPY[outcome.kind](outcome), ephemeral: true };
};

const cancel: Handler = async (ctx, input) => {
  const { canceled } = await ctx.roster.cancelLink(input.actorDiscordId);
  return { content: canceled ? "Challenge canceled. Draw a new one with `/link start`." : "You had no open challenge.", ephemeral: true };
};

/** `unlink` releases a solo base and is refused inside a clan; both rules are the store's. */
const unlink: Handler = async (ctx, input) => {
  const outcome = await ctx.roster.unlink(input.actorDiscordId);
  if (outcome.ok) return { content: UNLINK_COPY.ok!, ephemeral: true };
  return { content: UNLINK_COPY[outcome.reason]!, ephemeral: true };
};

/** The log's own list of characters. Autocomplete is scoped by prefix, not by viewer: the site's /link box is the same. */
const characters: AutocompleteSource = async (ctx, a) => {
  if (a.value.trim().length === 0) return [];
  const matches = await ctx.roster.searchGamertags(a.value.slice(0, 64));
  return matches.slice(0, 25).map((m) => ({ name: m.gamertag, value: m.dayzId }));
};

export const linkGroup: CommandGroup = {
  command: new SlashCommandBuilder()
    .setName("link")
    .setDescription("Link your Discord account to your in-game character")
    .addSubcommand((s) => s.setName("status").setDescription("Your link and any open challenge"))
    .addSubcommand((s) => s
      .setName("start")
      .setDescription("Draw a challenge for one of your characters")
      .addStringOption((o) => o.setName("character").setDescription("Your in-game name").setRequired(true).setAutocomplete(true))
      .addBooleanOption((o) => o.setName("redraw").setDescription("Draw a different sequence")))
    .addSubcommand((s) => s.setName("cancel").setDescription("Drop your open challenge"))
    .addSubcommand((s) => s.setName("unlink").setDescription("Unbind your character")),
  specs: [
    { path: "link status", handler: status },
    { path: "link start", handler: start, autocomplete: { character: characters } },
    { path: "link cancel", handler: cancel },
    { path: "link unlink", handler: unlink },
  ],
};
