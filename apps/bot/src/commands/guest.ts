import { SlashCommandBuilder } from "discord.js";
import { discordCopy } from "@factions/copy";
import { idOf } from "./parse.js";
import { linkedPlayers } from "./roster.js";
import type { AutocompleteSource, CommandGroup, Handler } from "./types.js";

/**
 * P6/P2: the same "linked players only" source `/roster invite` uses — an
 * unlinked account has no Discord id the roster call could resolve — so it
 * is written once, in `roster.ts`, and imported here.
 *
 * ⚠️ No channel check. `handleGuestCommand` resolved the clan from
 * `interaction.channelId`; `grantGuestPass` re-derives it from the actor's
 * own membership, so this runs anywhere. The permission check is unchanged:
 * `grantGuestPassDbFor` re-derives the actor's officer role under the clan's
 * row lock either way.
 */
const grant: Handler = async (ctx, input) => {
  const user = input.user("user");
  const gamertag = input.string("gamertag");
  if (!user && !gamertag) return { content: "Pick a Discord user or type a linked gamertag.", ephemeral: true };
  const target = user ? { discordId: user } : { gamertag: gamertag! };
  const { outcome } = await ctx.roster.grantGuestPass(input.actorDiscordId, target);
  return { content: discordCopy("guest", outcome), ephemeral: true };
};

const revoke: Handler = async (ctx, input) => {
  const id = idOf(input.string("pass"));
  if (!id) return { content: "Pick a pass from the list.", ephemeral: true };
  return { content: discordCopy("revoke-guest", await ctx.roster.revokeGuestPass(input.actorDiscordId, id)), ephemeral: true };
};

/** Officer+ only clans have any passes to show — `clanFor` answers a string for anyone else, so this offers nothing. */
const passes: AutocompleteSource = async (ctx, a) => {
  const view = await ctx.roster.clanFor(a.actorDiscordId);
  if (typeof view === "string") return [];
  return view.guestPasses.map((p) => ({ name: `guest ${p.userDiscordId}`, value: String(p.id) }));
};

export const guestGroup: CommandGroup = {
  command: new SlashCommandBuilder()
    .setName("guest")
    .setDescription("Voice guest passes for your clan's channel")
    .addSubcommand((s) => s.setName("grant").setDescription("Give someone a 24h voice guest pass")
      .addUserOption((o) => o.setName("user").setDescription("Who, by Discord account"))
      .addStringOption((o) => o.setName("gamertag").setDescription("Who, by linked in-game name").setAutocomplete(true)))
    .addSubcommand((s) => s.setName("revoke").setDescription("End an open guest pass early")
      .addStringOption((o) => o.setName("pass").setDescription("Which pass").setRequired(true).setAutocomplete(true))),
  specs: [
    { path: "guest grant", handler: grant, autocomplete: { gamertag: linkedPlayers } },
    { path: "guest revoke", handler: revoke, autocomplete: { pass: passes } },
  ],
};
