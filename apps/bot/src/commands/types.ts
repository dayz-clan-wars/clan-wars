import type {
  ActionRowBuilder,
  ButtonBuilder,
  EmbedBuilder,
  ModalBuilder,
  SlashCommandBuilder,
  SlashCommandSubcommandsOnlyBuilder,
  StringSelectMenuBuilder,
} from "discord.js";
import type { Roster } from "@factions/roster";

/** A row a `Reply` can carry: buttons or a single select menu, never mixed in one row. */
export type ReplyRow = ActionRowBuilder<ButtonBuilder> | ActionRowBuilder<StringSelectMenuBuilder>;

/**
 * ⚠️ Every reply is ephemeral — see the note on `Reply` in
 * `apps/bot/src/commands.ts`. There is no `public` option and there must
 * never be one: a challenge sequence posted publicly is a challenge any
 * bystander can perform, and a clan's roster, base or vault is a raid target.
 */
export type Reply = {
  content?: string;
  embeds?: EmbedBuilder[];
  components?: ReplyRow[];
  /** Set instead of the fields above: the router opens this modal rather than editing a reply. */
  modal?: ModalBuilder;
  ephemeral: true;
};

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

/**
 * A pressed button or a chosen select-menu option. `route.ts` has already
 * checked the presser against the actor named in the custom id before this
 * runs — see the note on `CommandGroup.components`.
 */
export type ComponentHandler = (
  ctx: Ctx,
  a: { actorDiscordId: string; arg: string | null; values: string[] },
) => Promise<Reply>;

/** A submitted modal. `field` reads one text input by the name it was given when the modal was built. */
export type ModalHandler = (
  ctx: Ctx,
  a: { actorDiscordId: string; arg: string | null; field: (name: string) => string },
) => Promise<Reply>;

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
  /**
   * Keyed by the action segment of a `cw:c:<action>:…` id. `route.ts` is the
   * only file that unpacks a custom id — a group just names the actions it
   * answers, the same way `specs` names the subcommand paths it answers.
   */
  components?: Record<string, ComponentHandler>;
  /** Keyed by the action segment of a `cw:m:<action>:…` id. */
  modals?: Record<string, ModalHandler>;
  /**
   * Component actions whose handler returns a modal instead of a reply.
   *
   * ⚠️ Discord refuses `showModal` on an interaction that has already been
   * acknowledged, so the router must NOT defer these — it calls the handler
   * first and shows the modal it returns. Nothing in this task uses it; it is
   * built here because it is the router's business, and a later task is the
   * only user.
   */
  modalOpeners?: string[];
};
