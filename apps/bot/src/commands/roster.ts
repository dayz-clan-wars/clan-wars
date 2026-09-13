import { SlashCommandBuilder } from "discord.js";
import { discordCopy } from "@factions/copy";
import { confirmReply } from "./confirm.js";
import { idOf } from "./parse.js";
import type { AutocompleteSource, CommandGroup, ComponentHandler, Handler } from "./types.js";

/** `clanFor` answers a string when the actor has no clan to read; autocomplete then offers nothing. */
async function clanView(ctx: Parameters<Handler>[0], discordId: string) {
  const view = await ctx.roster.clanFor(discordId);
  return typeof view === "string" ? null : view;
}

const invite: Handler = async (ctx, input) => {
  const gamertag = input.string("gamertag");
  if (!gamertag) return { content: "Pick a player from the list.", ephemeral: true };
  const { outcome } = await ctx.roster.invite(input.actorDiscordId, { gamertag });
  return { content: discordCopy("invite", outcome), ephemeral: true };
};

const revoke: Handler = async (ctx, input) => {
  const id = idOf(input.string("invite"));
  if (!id) return { content: "Pick an invite from the list.", ephemeral: true };
  return { content: discordCopy("revoke", await ctx.roster.revokeInvite(input.actorDiscordId, id)), ephemeral: true };
};

const decide: Handler = async (ctx, input) => {
  const id = idOf(input.string("request"));
  if (!id) return { content: "Pick a request from the list.", ephemeral: true };
  const decision = input.boolean("accept") === true ? "accepted" : "declined";
  return { content: discordCopy("decide", await ctx.roster.decideRequest(input.actorDiscordId, id, decision)), ephemeral: true };
};

const kick: Handler = async (ctx, input) => {
  const target = input.user("member");
  if (!target) return { content: "Pick the member to remove.", ephemeral: true };
  return { content: discordCopy("kick", await ctx.roster.kick(input.actorDiscordId, target)), ephemeral: true };
};

const promote: Handler = async (ctx, input) => {
  const target = input.user("member");
  if (!target) return { content: "Pick the member to promote.", ephemeral: true };
  return { content: discordCopy("role", await ctx.roster.promote(input.actorDiscordId, target)), ephemeral: true };
};

const demote: Handler = async (ctx, input) => {
  const target = input.user("member");
  if (!target) return { content: "Pick the officer to demote.", ephemeral: true };
  return { content: discordCopy("role", await ctx.roster.demote(input.actorDiscordId, target)), ephemeral: true };
};

/** R2: no write here. The Confirm button carries the target and does the write. */
const transfer: Handler = async (ctx, input) => {
  const target = input.user("member");
  if (!target) return { content: "Pick the member to hand leadership to.", ephemeral: true };
  return confirmReply("transfer", input.actorDiscordId, discordCopy("transfer", "unconfirmed"), target);
};

const confirmTransfer: ComponentHandler = async (ctx, a) => {
  if (!a.arg) return { content: "That button lost its target. Run `/roster transfer` again.", ephemeral: true };
  return { content: discordCopy("transfer", await ctx.roster.transfer(a.actorDiscordId, a.arg)), ephemeral: true };
};

/** Linked players only: an invite to an unlinked account cannot be accepted. Exported for `/guest grant` (a later task) to reuse. */
export const linkedPlayers: AutocompleteSource = async (ctx, a) => {
  if (a.value.trim().length === 0) return [];
  const names = await ctx.roster.suggestGamertags(a.value.slice(0, 64), "linked");
  return names.map((n) => ({ name: n, value: n }));
};

const invitesOut: AutocompleteSource = async (ctx, a) => {
  const view = await clanView(ctx, a.actorDiscordId);
  return (view?.invitesOut ?? []).map((i) => ({ name: i.inviteeGamertag ?? i.inviteeDiscordId, value: String(i.id) }));
};

const requestsIn: AutocompleteSource = async (ctx, a) => {
  const view = await clanView(ctx, a.actorDiscordId);
  return (view?.requestsIn ?? []).map((r) => ({ name: r.gamertag ?? r.discordId, value: String(r.id) }));
};

export const rosterGroup: CommandGroup = {
  command: new SlashCommandBuilder()
    .setName("roster")
    .setDescription("Your clan's roster")
    .addSubcommand((s) => s.setName("invite").setDescription("Invite a linked player")
      .addStringOption((o) => o.setName("gamertag").setDescription("Their in-game name").setRequired(true).setAutocomplete(true)))
    .addSubcommand((s) => s.setName("revoke").setDescription("Withdraw an invite you sent")
      .addStringOption((o) => o.setName("invite").setDescription("Which invite").setRequired(true).setAutocomplete(true)))
    .addSubcommand((s) => s.setName("decide").setDescription("Accept or decline a join request")
      .addStringOption((o) => o.setName("request").setDescription("Which request").setRequired(true).setAutocomplete(true))
      .addBooleanOption((o) => o.setName("accept").setDescription("Accept it (leave off to decline)").setRequired(true)))
    .addSubcommand((s) => s.setName("kick").setDescription("Remove a member")
      .addUserOption((o) => o.setName("member").setDescription("Who").setRequired(true)))
    .addSubcommand((s) => s.setName("promote").setDescription("Promote a member to officer")
      .addUserOption((o) => o.setName("member").setDescription("Who").setRequired(true)))
    .addSubcommand((s) => s.setName("demote").setDescription("Demote an officer to member")
      .addUserOption((o) => o.setName("member").setDescription("Who").setRequired(true)))
    .addSubcommand((s) => s.setName("transfer").setDescription("Hand leadership to another full member")
      .addUserOption((o) => o.setName("member").setDescription("Who").setRequired(true))),
  specs: [
    { path: "roster invite", handler: invite, autocomplete: { gamertag: linkedPlayers } },
    { path: "roster revoke", handler: revoke, autocomplete: { invite: invitesOut } },
    { path: "roster decide", handler: decide, autocomplete: { request: requestsIn } },
    { path: "roster kick", handler: kick },
    { path: "roster promote", handler: promote },
    { path: "roster demote", handler: demote },
    { path: "roster transfer", handler: transfer },
  ],
  components: { transfer: confirmTransfer },
};
