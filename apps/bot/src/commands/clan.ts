import { SlashCommandBuilder } from "discord.js";
import { DISBAND_WARNING, REFUSAL, discordCopy } from "@factions/copy";
import { clanEmbed } from "./embeds/clan.js";
import { confirmReply } from "./confirm.js";
import { clanView } from "./roster.js";
import type { AutocompleteSource, CommandGroup, ComponentHandler, Handler } from "./types.js";

const info: Handler = async (ctx, input) => {
  const view = await ctx.roster.clanFor(input.actorDiscordId);
  if (view === "not-linked") return { content: REFUSAL["not-linked"], ephemeral: true };
  if (view === "not-in-clan") return { content: `${REFUSAL["not-in-clan"]} Browse with \`/clans list\`.`, ephemeral: true };
  return { embeds: [clanEmbed(view, ctx.siteBaseUrl)], ephemeral: true };
};

/** R3: the site does not gate Leave behind a checkbox, so neither does Discord. */
const leave: Handler = async (ctx, input) =>
  ({ content: discordCopy("leave", await ctx.roster.leave(input.actorDiscordId)), ephemeral: true });

const rename: Handler = async (ctx, input) => {
  const name = input.string("name");
  if (!name) return { content: "Give the new name.", ephemeral: true };
  const tag = input.string("tag");
  const outcome = await ctx.roster.rename(input.actorDiscordId, tag ? { name, tag } : { name });
  return { content: discordCopy("rename", outcome), ephemeral: true };
};

const recruiting: Handler = async (ctx, input) => {
  const outcome = await ctx.roster.setRecruitingPost(input.actorDiscordId, {
    recruiting: input.boolean("open") === true,
    playWindow: input.string("hours"),
    language: input.string("language"),
    pitch: input.string("pitch"),
  });
  return { content: discordCopy("recruiting", outcome), ephemeral: true };
};

const rebind: Handler = async (ctx, input) => {
  const pole = input.string("pole");
  if (!pole) return { content: "Pick a pole from the list.", ephemeral: true };
  return { content: discordCopy("rebind", await ctx.roster.confirmRebind(input.actorDiscordId, pole)), ephemeral: true };
};

/** R2. The warning is part of the prompt because the button is one press from irreversible. */
const disband: Handler = async (ctx, input) =>
  confirmReply("disband", input.actorDiscordId, `${DISBAND_WARNING}\n\n${discordCopy("disband", "unconfirmed")}`);

const confirmDisband: ComponentHandler = async (ctx, a) =>
  ({ content: discordCopy("disband", await ctx.roster.disband(a.actorDiscordId)), ephemeral: true });

/** ⚠️ Label by raiser and time. The pole key is the VALUE, which Discord never shows. */
const poles: AutocompleteSource = async (ctx, a) => {
  const view = await clanView(ctx, a.actorDiscordId);
  return (view?.rebindCandidates ?? []).map((c) => ({ name: `raised by ${c.by}`, value: c.poleKey }));
};

export const clanGroup: CommandGroup = {
  command: new SlashCommandBuilder()
    .setName("clan")
    .setDescription("Your clan's page and the leader's settings")
    .addSubcommand((s) => s.setName("info").setDescription("Your clan's page"))
    .addSubcommand((s) => s.setName("leave").setDescription("Leave your clan"))
    .addSubcommand((s) => s.setName("rename").setDescription("Rename the clan")
      .addStringOption((o) => o.setName("name").setDescription("New name").setRequired(true))
      .addStringOption((o) => o.setName("tag").setDescription("New tag").setRequired(false)))
    .addSubcommand((s) => s.setName("recruiting").setDescription("Edit the recruiting post")
      .addBooleanOption((o) => o.setName("open").setDescription("Recruiting open").setRequired(true))
      .addStringOption((o) => o.setName("hours").setDescription("Play window").setRequired(false))
      .addStringOption((o) => o.setName("language").setDescription("Language").setRequired(false))
      .addStringOption((o) => o.setName("pitch").setDescription("Pitch").setRequired(false)))
    .addSubcommand((s) => s.setName("rebind").setDescription("Move your base to a pole your flag was raised at")
      .addStringOption((o) => o.setName("pole").setDescription("Which pole").setRequired(true).setAutocomplete(true)))
    .addSubcommand((s) => s.setName("disband").setDescription("Disband the clan")),
  specs: [
    { path: "clan info", handler: info },
    { path: "clan leave", handler: leave },
    { path: "clan rename", handler: rename },
    { path: "clan recruiting", handler: recruiting },
    { path: "clan rebind", handler: rebind, autocomplete: { pole: poles } },
    { path: "clan disband", handler: disband },
  ],
  components: { disband: confirmDisband },
};
