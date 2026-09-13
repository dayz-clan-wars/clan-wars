import { SlashCommandBuilder } from "discord.js";
import { discordCopy } from "@factions/copy";
import { meEmbed } from "./embeds/me.js";
import { idOf } from "./parse.js";
import type { AutocompleteSource, CommandGroup, Handler } from "./types.js";

const show: Handler = async (ctx, input) => {
  const [viewer, attention, invites, requests] = await Promise.all([
    ctx.roster.viewerFor(input.actorDiscordId),
    ctx.roster.attention(input.actorDiscordId),
    ctx.roster.myInvites(input.actorDiscordId),
    ctx.roster.myRequests(input.actorDiscordId),
  ]);
  return { embeds: [meEmbed(viewer, attention, invites, requests, ctx.siteBaseUrl)], ephemeral: true };
};

const accept: Handler = async (ctx, input) => {
  const id = idOf(input.string("invite"));
  if (!id) return { content: "Pick an invite from the list.", ephemeral: true };
  return { content: discordCopy("accept", await ctx.roster.acceptInvite(input.actorDiscordId, id)), ephemeral: true };
};

const decline: Handler = async (ctx, input) => {
  const id = idOf(input.string("invite"));
  if (!id) return { content: "Pick an invite from the list.", ephemeral: true };
  const done = await ctx.roster.declineInvite(input.actorDiscordId, id);
  return { content: discordCopy("decline", done ? "declined" : "gone"), ephemeral: true };
};

const withdraw: Handler = async (ctx, input) => {
  const id = idOf(input.string("request"));
  if (!id) return { content: "Pick a request from the list.", ephemeral: true };
  const done = await ctx.roster.withdrawRequest(input.actorDiscordId, id);
  return { content: discordCopy("withdraw", done ? "withdrawn" : "gone"), ephemeral: true };
};

/** `myInvites` is already scoped to the actor — there is no wider list to leak. */
const invites: AutocompleteSource = async (ctx, a) => {
  const rows = await ctx.roster.myInvites(a.actorDiscordId);
  return rows.map((r) => ({ name: `${r.clanName} [${r.tag}]`, value: String(r.id) }));
};

const requests: AutocompleteSource = async (ctx, a) => {
  const rows = await ctx.roster.myRequests(a.actorDiscordId);
  return rows.map((r) => ({ name: `${r.clanName} [${r.tag}]`, value: String(r.id) }));
};

export const meGroup: CommandGroup = {
  command: new SlashCommandBuilder()
    .setName("me")
    .setDescription("You: your character, your clan, and what is waiting on you")
    .addSubcommand((s) => s.setName("show").setDescription("Your page"))
    .addSubcommand((s) => s.setName("accept").setDescription("Accept a clan invite")
      .addStringOption((o) => o.setName("invite").setDescription("Which invite").setRequired(true).setAutocomplete(true)))
    .addSubcommand((s) => s.setName("decline").setDescription("Decline a clan invite")
      .addStringOption((o) => o.setName("invite").setDescription("Which invite").setRequired(true).setAutocomplete(true)))
    .addSubcommand((s) => s.setName("withdraw").setDescription("Withdraw one of your join requests")
      .addStringOption((o) => o.setName("request").setDescription("Which request").setRequired(true).setAutocomplete(true))),
  specs: [
    { path: "me show", handler: show },
    { path: "me accept", handler: accept, autocomplete: { invite: invites } },
    { path: "me decline", handler: decline, autocomplete: { invite: invites } },
    { path: "me withdraw", handler: withdraw, autocomplete: { request: requests } },
  ],
};
