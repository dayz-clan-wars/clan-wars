import type {
  ActionRowBuilder,
  ButtonBuilder,
  EmbedBuilder,
  ModalBuilder,
  SlashCommandBuilder,
  SlashCommandOptionsOnlyBuilder,
  SlashCommandSubcommandsOnlyBuilder,
  StringSelectMenuBuilder,
} from "discord.js";
import type { Roster } from "@factions/roster";
import type { Database } from "@factions/db";

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
  /**
   * Whether the caller holds Manage Server in this guild.
   *
   * ⚠️ Read from the interaction's OWN member permissions, never from a role id
   * in config: a role can be renamed, deleted or handed out, and the permission
   * is the thing Discord actually enforces.
   */
  isAdmin: boolean;
};

export type Ctx = {
  roster: Roster;
  /** For formatting only. Domain time comes from the roster instance's own clock. */
  now: Date;
  siteBaseUrl: string;
  /**
   * ⚠️ The only command that touches this is `/airdrop place`, which has no
   * roster call to make: an airdrop is server state, not clan state, so there is
   * nothing for `@factions/roster` to export. Do not reach for it from a clan
   * command — those go through `roster`, which is what keeps the site and the
   * commands one set of rules rather than two.
   */
  db: Database;
  /** The `SERVER_EVENTS_CHANNEL_ID` poster, or null when `AIRDROP_TICK` is off. */
  serverEvents: ((content: string) => Promise<void>) | null;
  /**
   * `BOUNTY_TICK`. `/bounty place` refuses when it is off: with no tick and no
   * poster, a bounty would be a punishment nobody is told about and nobody can collect.
   */
  bountiesEnabled: boolean;
  /** The KotH announcement poster (mentions off), or null when `KOTH_TICK` is off. */
  koth: ((content: string) => Promise<void>) | null;
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
  /**
   * The handler returns `{ modal }` and the router must NOT defer.
   *
   * ⚠️ Discord refuses `showModal` on an interaction that has already been
   * acknowledged, and a deferred interaction is acknowledged. A spec marked
   * this way therefore has ~3 seconds total: one indexed read before
   * building the modal is fine, a chain of them is not.
   */
  opensModal?: true;
};

export type CommandGroup = {
  command: SlashCommandBuilder | SlashCommandSubcommandsOnlyBuilder | SlashCommandOptionsOnlyBuilder;
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
   * first and shows the modal it returns. `/found`'s "found-name" button is
   * its only user: see `foundGroup` in `found.ts`.
   */
  modalOpeners?: string[];
  /**
   * Component actions whose reply should EDIT the message the component sits
   * on rather than post a new ephemeral one — select menus that refine a
   * card in place.
   *
   * ⚠️ Without this the router defers a fresh reply per interaction, so a
   * player who picks a flag and then a crew ends up looking at three copies
   * of the same card, only the last of which is current.
   */
  updatesInPlace?: string[];
};
