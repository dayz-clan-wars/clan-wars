import { SlashCommandBuilder } from "discord.js";
import { REFUSAL } from "@factions/copy";
import { vaultEmbed } from "./embeds/vault.js";
import type { AutocompleteSource, CommandGroup, Handler } from "./types.js";

/**
 * ⚠️ `vaultFor` IS the permission check, on every subcommand that needs one:
 * it rank-filters the locks and returns a refusal string for a player who is
 * unlinked, clanless or pending. A refusal is a sentence, never an empty
 * card, so each handler narrows with `typeof state === "string"` and answers
 * from `REFUSAL`.
 */
const list: Handler = async (ctx, input) => {
  const state = await ctx.roster.vaultFor(input.actorDiscordId);
  if (typeof state === "string") return { content: REFUSAL[state], ephemeral: true };
  return { embeds: [vaultEmbed(state, ctx.siteBaseUrl)], ephemeral: true };
};

/**
 * The `lock:` option on every other vault subcommand.
 *
 * ⚠️ Labels carry the name and the rank gate, never a code — `VaultLockView`
 * has no code field, and nothing here may join one on. An actor who cannot
 * see a vault at all gets an empty list rather than an error: Discord shows
 * "no options match", which is the truthful answer.
 */
export const locks: AutocompleteSource = async (ctx, a) => {
  const state = await ctx.roster.vaultFor(a.actorDiscordId);
  if (typeof state === "string") return [];
  const q = a.value.trim().toLowerCase();
  return state.locks
    .filter((l) => q === "" || l.name.toLowerCase().includes(q))
    .map((l) => ({ name: l.name, value: String(l.id) }));
};

export const vaultGroup: CommandGroup = {
  command: new SlashCommandBuilder()
    .setName("vault")
    .setDescription("Your clan's lock codes")
    .addSubcommand((s) => s.setName("list").setDescription("The locks your rank may see")),
  specs: [
    { path: "vault list", handler: list },
  ],
};
