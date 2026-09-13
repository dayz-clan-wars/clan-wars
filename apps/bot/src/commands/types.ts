import type { EmbedBuilder, SlashCommandBuilder, SlashCommandSubcommandsOnlyBuilder } from "discord.js";
import type { Roster } from "@factions/roster";

/**
 * ⚠️ Every reply is ephemeral — see the note on `Reply` in
 * `apps/bot/src/commands.ts`. There is no `public` option and there must
 * never be one: a challenge sequence posted publicly is a challenge any
 * bystander can perform, and a clan's roster, base or vault is a raid target.
 */
export type Reply = { content?: string; embeds?: EmbedBuilder[]; ephemeral: true };

/**
 * What a handler is given instead of a discord.js interaction. `route.ts` is
 * the only file that unpacks one; everything downstream is a pure function of
 * these fields and is unit-testable with no client — the shape
 * `handleGuestCommand` already had.
 */
export type CommandInput = {
  /**
   * `interaction.user.id`. The SAME Discord snowflake the site's session
   * cookie holds in `sub`, which is why no new credential is needed: the
   * roster call re-derives everything else from it.
   */
  actorDiscordId: string;
  string: (name: string) => string | null;
  integer: (name: string) => number | null;
  boolean: (name: string) => boolean | null;
  /** A resolved user option's id, or null. */
  user: (name: string) => string | null;
};

export type Ctx = {
  roster: Roster;
  /** For formatting only. Domain time comes from the roster instance's own clock. */
  now: Date;
  siteBaseUrl: string;
};

export type Handler = (ctx: Ctx, input: CommandInput) => Promise<Reply>;

/** Discord allows 25 choices and gives 3 seconds; every source below is one indexed query. */
export type AutocompleteSource = (
  ctx: Ctx,
  a: { actorDiscordId: string; value: string },
) => Promise<{ name: string; value: string }[]>;

export type CommandSpec = {
  /** "base" for a bare command, "base declare" for a subcommand. Matches `command-registration.test.ts`. */
  path: string;
  handler: Handler;
  /** Keyed by option name. */
  autocomplete?: Record<string, AutocompleteSource>;
};

export type CommandGroup = {
  command: SlashCommandBuilder | SlashCommandSubcommandsOnlyBuilder;
  specs: CommandSpec[];
};
