import {
  Client, GatewayIntentBits, REST, Routes, MessageFlags, PermissionFlagsBits,
  SlashCommandBuilder, ActionRowBuilder, StringSelectMenuBuilder, ButtonBuilder, ButtonStyle,
  type RESTPostAPIApplicationCommandsJSONBody, type InteractionEditReplyOptions,
} from "discord.js";
import { createClient } from "@factions/db";
import { CLAIMABLE_FLAGS, emoteLabel } from "@factions/domain";
import { handleLink, handleUnlink, handleWhoami, type CommandDeps, type Reply } from "./commands.js";
import { PgVerificationStore } from "./store.js";
import { verificationTick } from "./tick.js";
import { runPlayerProjection } from "./player-tick.js";
import type { BotConfig } from "./config.js";
import { createNotifyFailureLog, type NotifyFailureLog, type Sender } from "./notify.js";
import { applyNickname, type NicknameOutcome, type GuildLike } from "./nickname.js";
import { handleFactionClaim, handleClaimConfirm, type FactionDeps, type FactionReply } from "./faction-commands.js";
import { PgFactionStore } from "./faction-store.js";
import { PgCeremonyStore } from "./ceremony-store.js";
import { ceremonyTick } from "./ceremony-tick.js";
import { notifyCeremonies } from "./ceremony-notify.js";
import { dormancyTick } from "./dormancy-tick.js";
import { PgDormancyStore } from "./dormancy-store.js";
import { notifyDormancy } from "./dormancy-notify.js";
import {
  handleFactionInvite, handleFactionInvites, handleInviteAccept, handleInviteDecline,
  handleFactionKick, handleFactionLeave, handleFactionPromote, handleFactionDemote,
  handleFactionTransfer, handleFactionDisband, handleFactionRename,
  handleFactionInfo, handleFactionRoster,
  type RosterDeps, type RosterReply, type RosterPrompt,
} from "./roster-commands.js";
import { PgRosterStore, type Membership } from "./roster-store.js";
import { handleFactionRebind, handleRebindConfirm, type RebindDeps } from "./rebind-commands.js";
import { PgRebindStore } from "./rebind-store.js";

// Registration (buildCommands) and reading (the interactionCreate handler)
// live hundreds of lines apart in this file. A string literal duplicated at
// both sites can drift silently — Discord would then hand the value under a
// name the reader never asks for, and getString would return null for every
// /link, invisibly. Sharing this constant makes that class of bug impossible.
export const LINK_GAMERTAG_OPTION = "gamertag";
/**
 * Asks /link for a DIFFERENT sequence rather than re-showing the live one.
 * Shares a constant with the reader for the same reason as the option above:
 * a typo at one end reads as null at the other, silently.
 */
export const LINK_NEW_SEQUENCE_OPTION = "new-sequence";

export function buildCommands(): RESTPostAPIApplicationCommandsJSONBody[] {
  return [
    new SlashCommandBuilder().setName("link")
      .setDescription("Bind your Discord account to your in-game character")
      .addStringOption((o) => o.setName(LINK_GAMERTAG_OPTION)
        .setDescription("Which character is yours")
        .setRequired(true)
        .setAutocomplete(true))
      .addBooleanOption((o) => o.setName(LINK_NEW_SEQUENCE_OPTION)
        .setDescription("Give me different emotes — I can't perform one of these")),
    new SlashCommandBuilder().setName("unlink")
      .setDescription("Remove the binding between your Discord account and your character"),
    new SlashCommandBuilder().setName("whoami")
      .setDescription("Show which character your Discord account is linked to"),
    new SlashCommandBuilder().setName("faction")
      .setDescription("Faction commands")
      .addSubcommand((s) => s.setName("claim")
        .setDescription("Found a faction from a ceremony you took part in")
        .addStringOption((o) => o.setName("name").setDescription("Faction name").setRequired(true).setMaxLength(64))
        .addStringOption((o) => o.setName("tag").setDescription("Short tag, 2-5 letters or digits").setRequired(true).setMaxLength(5))
        .addStringOption((o) => o.setName("flag").setDescription("One of the 33 claimable flags").setRequired(true).setAutocomplete(true)))
      .addSubcommand((s) => s.setName("invite")
        .setDescription("Invite a linked player to your faction")
        .addUserOption((o) => o.setName("user").setDescription("Who to invite").setRequired(true))
        .addIntegerOption((o) => o.setName("server").setDescription("Which server, if you hold a faction on more than one").setAutocomplete(true)))
      .addSubcommand((s) => s.setName("invites")
        .setDescription("List your pending faction invitations"))
      .addSubcommand((s) => s.setName("kick")
        .setDescription("Remove a member from your faction")
        .addUserOption((o) => o.setName("user").setDescription("Who to kick").setRequired(true))
        .addIntegerOption((o) => o.setName("server").setDescription("Which server, if you hold a faction on more than one").setAutocomplete(true)))
      .addSubcommand((s) => s.setName("leave")
        .setDescription("Leave your faction")
        .addIntegerOption((o) => o.setName("server").setDescription("Which server, if you hold a faction on more than one").setAutocomplete(true)))
      .addSubcommand((s) => s.setName("promote")
        .setDescription("Promote a member to officer")
        .addUserOption((o) => o.setName("user").setDescription("Who to promote").setRequired(true))
        .addIntegerOption((o) => o.setName("server").setDescription("Which server, if you hold a faction on more than one").setAutocomplete(true)))
      .addSubcommand((s) => s.setName("demote")
        .setDescription("Demote an officer to member")
        .addUserOption((o) => o.setName("user").setDescription("Who to demote").setRequired(true))
        .addIntegerOption((o) => o.setName("server").setDescription("Which server, if you hold a faction on more than one").setAutocomplete(true)))
      .addSubcommand((s) => s.setName("transfer")
        .setDescription("Transfer leadership to another member")
        .addUserOption((o) => o.setName("user").setDescription("Who to make leader").setRequired(true))
        .addIntegerOption((o) => o.setName("server").setDescription("Which server, if you hold a faction on more than one").setAutocomplete(true)))
      .addSubcommand((s) => s.setName("disband")
        .setDescription("Disband your faction, releasing its flag, tag and pole")
        .addIntegerOption((o) => o.setName("server").setDescription("Which server, if you hold a faction on more than one").setAutocomplete(true)))
      .addSubcommand((s) => s.setName("rename")
        .setDescription("Rename your faction")
        .addStringOption((o) => o.setName("name").setDescription("New faction name").setRequired(true).setMaxLength(64))
        .addIntegerOption((o) => o.setName("server").setDescription("Which server, if you hold a faction on more than one").setAutocomplete(true)))
      .addSubcommand((s) => s.setName("rebind")
        .setDescription("Move your faction's base to a new flagpole")
        .addIntegerOption((o) => o.setName("server").setDescription("Which server, if you hold a faction on more than one").setAutocomplete(true)))
      .addSubcommand((s) => s.setName("roster")
        .setDescription("Show a faction's roster")
        .addStringOption((o) => o.setName("name").setDescription("Faction name; defaults to your own"))
        .addIntegerOption((o) => o.setName("server").setDescription("Which server, if you hold a faction on more than one").setAutocomplete(true)))
      .addSubcommand((s) => s.setName("info")
        .setDescription("Show a faction's public info card")
        .addStringOption((o) => o.setName("name").setDescription("Faction name; defaults to your own"))
        .addIntegerOption((o) => o.setName("server").setDescription("Which server, if you hold a faction on more than one").setAutocomplete(true))),
  ].map((c) => c.toJSON());
}

/**
 * What a player is told when a roster command throws.
 *
 * ⚠️ Every roster subcommand defers before it touches the store, and a
 * deferred interaction that never receives an `editReply` sits on "thinking"
 * for good. Logging the throw and dropping it — which is what the catch used
 * to do — leaves the player staring at that. This apology is also what covers
 * the `default:` arm of the subcommand switch, which is unreachable against a
 * current command registration but not against a stale guild one.
 */
export const INTERACTION_FAILURE_MESSAGE =
  "Something went wrong handling that. Try again in a moment.";

export type ApologisableInteraction = {
  deferred: boolean;
  replied: boolean;
  editReply: (opts: { content: string }) => Promise<unknown>;
};

/** Best effort: the interaction token may already be dead, and a throw from
 * inside a discord.js listener's catch is an unhandled rejection. */
export async function apologiseForFailure(i: ApologisableInteraction): Promise<void> {
  if (!i.deferred || i.replied) return;
  try {
    await i.editReply({ content: INTERACTION_FAILURE_MESSAGE });
  } catch (err) {
    console.error("could not deliver the failure apology", err);
  }
}

/** The subset of a discord.js interaction the router needs. Kept structural so tests need no client. */
export type InteractionLike = {
  commandName: string;
  userId: string;
  guildId: string | null;
  channelId: string;
  /** The `character` option of /link — a UID. Absent for every other command. */
  targetDayzId?: string | null;
  /** The `new-sequence` option of /link. Absent for every other command. */
  newSequence?: boolean | null;
};

export async function routeInteraction(deps: CommandDeps, i: InteractionLike): Promise<Reply | null> {
  const known = i.commandName === "link" || i.commandName === "unlink" || i.commandName === "whoami";
  if (!known) return null;

  // Identity is guild-scoped in practice (spec §16) and a DM has no guild to
  // record on the challenge, so refuse rather than write a null guild id.
  if (i.guildId === null) {
    return { content: "Run this in the server, not in a DM.", ephemeral: true };
  }

  const ctx = { discordId: i.userId, guildId: i.guildId, channelId: i.channelId };
  if (i.commandName === "link") {
    // The option is required at registration, so an absent value here means a
    // client (or a stale command) sent none. Refuse rather than link a blank
    // UID: an untargeted challenge is the bearer-token bug this work removes.
    if (!i.targetDayzId) {
      return { content: "Pick a character from the list when you run `/link`.", ephemeral: true };
    }
    return handleLink(deps, {
      ...ctx, targetDayzId: i.targetDayzId, newSequence: i.newSequence === true,
    });
  }
  if (i.commandName === "unlink") return handleUnlink(deps, i.userId, i.guildId);
  return handleWhoami(deps, i.userId);
}

export const CLAIM_PREFIX = "claim-confirm:";

/** Discord caps a custom id at 100 characters, which is why only the id rides here. */
export const claimCustomId = (ceremonyId: number): string => `${CLAIM_PREFIX}${ceremonyId}`;

export function parseClaimCustomId(customId: string): number | null {
  if (!customId.startsWith(CLAIM_PREFIX)) return null;
  const n = Number(customId.slice(CLAIM_PREFIX.length));
  return Number.isSafeInteger(n) && n > 0 ? n : null;
}

export type ComponentLike = { customId: string; userId: string; values: string[] };

export async function routeComponent(deps: FactionDeps, i: ComponentLike): Promise<FactionReply | null> {
  const ceremonyId = parseClaimCustomId(i.customId);
  if (ceremonyId === null) return null;
  return handleClaimConfirm(deps, i.userId, ceremonyId, i.values);
}

/** The subset of a select-menu interaction this handler needs. Structural so tests need no client. */
export type SelectInteractionLike = ComponentLike & {
  deferReply: (opts: { flags: number }) => Promise<unknown>;
  editReply: (opts: { content: string }) => Promise<unknown>;
};

/**
 * Answer a roster-confirm select. Returns false if the interaction is not ours.
 *
 * ⚠️ Deferred for the same reason `/faction claim` is, and with more at stake.
 * The confirm runs two queries plus a multi-statement transaction against
 * Discord's 3-second initial-response window, and a timeout here lands in the
 * worst possible order: `reserve()` has already committed, the flag, tag and
 * pole are out of the 33-slot pool, and the player is told "The application did
 * not respond" — with nothing to tell them their faction in fact exists.
 *
 * The custom-id check comes FIRST: Discord delivers every component
 * interaction in the guild, and deferring one we will never answer leaves
 * someone else's menu stuck on "thinking".
 */
export async function respondToClaimConfirm(
  deps: FactionDeps,
  i: SelectInteractionLike,
): Promise<boolean> {
  if (parseClaimCustomId(i.customId) === null) return false;
  await i.deferReply({ flags: MessageFlags.Ephemeral });
  const reply = await routeComponent(deps, { customId: i.customId, userId: i.userId, values: i.values });
  if (!reply) return false;
  await i.editReply({ content: reply.content });
  return true;
}

/** Discord's select-option cap, not our rule — see the "refuse" branch of `planClaimReply`. */
export const MAX_PRUNE_OPTIONS = 25;

export type PruneOption = { label: string; value: string; default: true };
export type ClaimRenderPlan =
  | { kind: "text"; content: string }
  | { kind: "select"; content: string; customId: string; options: PruneOption[]; maxValues: number }
  | { kind: "refuse"; content: string };

/**
 * Decides WHAT to render for a `FactionReply`, as plain data — no discord.js
 * types touched here so this is directly testable.
 *
 * ⚠️ A ceremony can have more participants than a single Discord string-select
 * can hold (25). The select's values BECOME the founding roster — silently
 * slicing to 25 would drop the 26th+ participant from the roster with no
 * error, exactly the loss the ceremony-settling window exists to prevent
 * (settling rather than firing on the first qualifying raise is what lets a
 * late founding member still be counted). So an over-cap ceremony is refused
 * loudly instead: no select is ever rendered, so no confirm can happen and no
 * faction is ever created from it.
 */
export function planClaimReply(reply: FactionReply): ClaimRenderPlan {
  if (!reply.prompt) return { kind: "text", content: reply.content };

  const { ceremonyId, participants } = reply.prompt;
  if (participants.length > MAX_PRUNE_OPTIONS) {
    return {
      kind: "refuse",
      content: `This ceremony has ${participants.length} participants, which is more than the ` +
        `${MAX_PRUNE_OPTIONS} the roster-confirmation menu can hold. Ask an admin to found this ` +
        "faction manually.",
    };
  }

  const options: PruneOption[] = participants.map((p) => ({ label: p.gamertag, value: p.dayzId, default: true }));
  return {
    kind: "select",
    content: reply.content,
    customId: claimCustomId(ceremonyId),
    options,
    maxValues: options.length,
  };
}

/**
 * Filters `CLAIMABLE_FLAGS` for the flag autocomplete, case-insensitively,
 * capped at Discord's 25-choice limit. Pure so it is directly testable
 * without a live autocomplete interaction.
 */
export function flagSuggestions(query: string): string[] {
  const q = query.toLowerCase();
  return CLAIMABLE_FLAGS.filter((f) => f.toLowerCase().includes(q)).slice(0, 25);
}

/**
 * Filters the recently-seen-and-unlinked candidate pool for the `/link`
 * `gamertag` autocomplete, case-insensitively, capped at Discord's 25-choice
 * limit. Pure so it is directly testable without a live autocomplete
 * interaction.
 *
 * ⚠️ The choice's value is the UID (`dayzId`), not the display name: two
 * characters can share a gamertag, and carrying the UID means the submit
 * path never has to re-resolve a name back to a player.
 */
export function playerSuggestions(
  players: { dayzId: string; gamertag: string }[],
  query: string,
): { name: string; value: string }[] {
  const q = query.toLowerCase();
  return players
    .filter((p) => p.gamertag.toLowerCase().includes(q))
    .slice(0, 25)
    // ⚠️ Discord caps a choice name at 100 characters and rejects the whole
    // response if one exceeds it — the field then renders EMPTY, so a single
    // overlong gamertag would make nobody pickable. Nothing constrains
    // `players.gamertag`, which is copied verbatim from an ADM line.
    .map((p) => ({ name: p.gamertag.slice(0, 100), value: p.dayzId }));
}

/**
 * Formats the caller's own faction memberships for the `server` autocomplete
 * option, capped at Discord's 25-choice limit. Pure so it is directly
 * testable without a live autocomplete interaction.
 */
export function serverChoices(memberships: Membership[]): { name: string; value: number }[] {
  return memberships.slice(0, 25).map((m) => ({ name: m.serverName, value: m.serverId }));
}

// ---------------------------------------------------------------------------
// Roster button custom ids
//
// Each prefix is its own namespace. Every parser below checks its prefix
// FIRST and returns null otherwise — Discord delivers every component
// interaction in the guild to this bot, so deferring one this router will
// never answer leaves someone else's button stuck on "thinking" forever.
// See `respondToClaimConfirm` above, which documents the same reasoning for
// `/faction claim`.
// ---------------------------------------------------------------------------

export const INVITE_ACCEPT_PREFIX = "invite-accept:";
export const INVITE_DECLINE_PREFIX = "invite-decline:";
export const TRANSFER_PREFIX = "roster-transfer:";
export const DISBAND_PREFIX = "roster-disband:";

export const inviteAcceptCustomId = (inviteId: number): string => `${INVITE_ACCEPT_PREFIX}${inviteId}`;
export const inviteDeclineCustomId = (inviteId: number): string => `${INVITE_DECLINE_PREFIX}${inviteId}`;
export const transferCustomId = (factionId: number, targetDiscordId: string): string =>
  `${TRANSFER_PREFIX}${factionId}:${targetDiscordId}`;
export const disbandCustomId = (factionId: number): string => `${DISBAND_PREFIX}${factionId}`;

export const REBIND_PREFIX = "rebind-confirm:";

/**
 * ⚠️ The pole key contains colons (`x:y:z`), so it goes LAST and is rejoined
 * rather than split. A naive `split(":")` would truncate it to `x` and the
 * confirm handler would look for a pole that does not exist — a button that
 * silently never works.
 */
export const rebindCustomId = (factionId: number, poleKey: string): string =>
  `${REBIND_PREFIX}${factionId}:${poleKey}`;

export function parseRebindCustomId(customId: string): { factionId: number; poleKey: string } | null {
  if (!customId.startsWith(REBIND_PREFIX)) return null;
  const rest = customId.slice(REBIND_PREFIX.length);
  const firstColon = rest.indexOf(":");
  if (firstColon <= 0) return null;
  const idPart = rest.slice(0, firstColon);
  const poleKey = rest.slice(firstColon + 1);
  // Decimal digits only — the same house rule config.ts and parseIdSuffix use,
  // because Number("9e2") is 900.
  if (!/^\d+$/u.test(idPart) || poleKey === "") return null;
  return { factionId: Number(idPart), poleKey };
}

/**
 * A custom id suffix is decimal digits or it is nothing.
 *
 * ⚠️ `Number()` alone accepts far more than that: `Number("9e2")` is 900 and
 * `Number("0x10")` is 16, so `invite-accept:9e2` would parse as invite 900.
 * Not exploitable — every consumer re-checks ownership — but `config.ts`
 * already sets this house rule and `parsePoleKey` was fixed for this exact
 * bug class. Validate the text, then coerce.
 */
const DECIMAL_RE = /^\d+$/u;

function parseIdSuffix(customId: string, prefix: string): number | null {
  if (!customId.startsWith(prefix)) return null;
  const raw = customId.slice(prefix.length);
  if (!DECIMAL_RE.test(raw)) return null;
  const n = Number(raw);
  return Number.isSafeInteger(n) && n > 0 ? n : null;
}

export function parseInviteAcceptCustomId(customId: string): number | null {
  return parseIdSuffix(customId, INVITE_ACCEPT_PREFIX);
}

export function parseInviteDeclineCustomId(customId: string): number | null {
  return parseIdSuffix(customId, INVITE_DECLINE_PREFIX);
}

export function parseDisbandCustomId(customId: string): number | null {
  return parseIdSuffix(customId, DISBAND_PREFIX);
}

export function parseTransferCustomId(customId: string): { factionId: number; targetDiscordId: string } | null {
  if (!customId.startsWith(TRANSFER_PREFIX)) return null;
  const rest = customId.slice(TRANSFER_PREFIX.length);
  const sep = rest.indexOf(":");
  if (sep === -1) return null;
  const factionId = Number(rest.slice(0, sep));
  const targetDiscordId = rest.slice(sep + 1);
  if (!Number.isSafeInteger(factionId) || factionId <= 0 || targetDiscordId === "") return null;
  return { factionId, targetDiscordId };
}

/** The subset of a button interaction the roster router needs. Structural so tests need no client. */
export type ButtonInteractionLike = {
  customId: string;
  userId: string;
  deferReply: (opts: { flags?: number }) => Promise<unknown>;
  editReply: (opts: { content: string }) => Promise<unknown>;
};

/**
 * Routes the four roster button prefixes. Returns false, without deferring,
 * for any custom id that is not ours — see the note above the prefix block.
 *
 * `/faction transfer` and `/faction disband` deliberately never call the
 * store (see `handleFactionTransfer` / `handleFactionDisband`): both are
 * confirmation-gated, and the store call belongs here, on the confirming
 * button. Disband especially — it is irreversible, releasing the flag, tag
 * and pole to a 33-slot pool a rival can claim immediately.
 */
export async function routeRosterButton(deps: RosterDeps, i: ButtonInteractionLike): Promise<boolean> {
  const acceptId = parseInviteAcceptCustomId(i.customId);
  if (acceptId !== null) {
    await i.deferReply({ flags: MessageFlags.Ephemeral });
    const reply = await handleInviteAccept(deps, i.userId, acceptId);
    await i.editReply({ content: reply.content });
    return true;
  }

  const declineId = parseInviteDeclineCustomId(i.customId);
  if (declineId !== null) {
    await i.deferReply({ flags: MessageFlags.Ephemeral });
    const reply = await handleInviteDecline(deps, i.userId, declineId);
    await i.editReply({ content: reply.content });
    return true;
  }

  const transfer = parseTransferCustomId(i.customId);
  if (transfer !== null) {
    await i.deferReply({ flags: MessageFlags.Ephemeral });
    const outcome = await deps.store.transfer({
      factionId: transfer.factionId, fromDiscordId: i.userId, toDiscordId: transfer.targetDiscordId, at: deps.now(),
    });
    const content = outcome === "ok"
      ? "Leadership has been transferred."
      : outcome === "not-leader"
        ? "Only the leader can transfer leadership."
        : `<@${transfer.targetDiscordId}> is no longer a member of that faction.`;
    await i.editReply({ content });
    return true;
  }

  const disbandFactionId = parseDisbandCustomId(i.customId);
  if (disbandFactionId !== null) {
    await i.deferReply({ flags: MessageFlags.Ephemeral });
    const outcome = await deps.store.disband(disbandFactionId, i.userId);
    const content = outcome === "ok"
      ? "The faction has been disbanded. Its flag, tag and pole are back in the pool."
      : "Only the leader can disband the faction.";
    await i.editReply({ content });
    return true;
  }

  return false;
}

/**
 * Routes the rebind confirm button. Kept as its own router rather than folded
 * into `routeRosterButton` — that function takes a plain `RosterDeps` and
 * several tests construct one directly; widening its signature to also carry
 * a `RebindDeps` would break every one of those call sites for a button that
 * is unrelated to them. `start()` calls this one second, only when
 * `routeRosterButton` reports the id was not its own. Same false-without-
 * deferring contract for a foreign id as `routeRosterButton` above.
 */
export async function routeRebindButton(deps: RebindDeps, i: ButtonInteractionLike): Promise<boolean> {
  const rebind = parseRebindCustomId(i.customId);
  if (rebind === null) return false;

  await i.deferReply({ flags: MessageFlags.Ephemeral });
  const reply = await handleRebindConfirm(deps, i.userId, rebind.factionId, rebind.poleKey);
  await i.editReply({ content: reply.content });
  return true;
}

function inviteButtons(inviteId: number): ActionRowBuilder<ButtonBuilder> {
  return new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId(inviteAcceptCustomId(inviteId)).setLabel("Accept").setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId(inviteDeclineCustomId(inviteId)).setLabel("Decline").setStyle(ButtonStyle.Danger),
  );
}

export type RosterButtonSpec = { customId: string; label: string; style: "success" | "danger" };

/**
 * Decides WHAT buttons a `RosterReply.prompt` needs, as plain data — no
 * discord.js types touched here so this is directly testable, the same
 * reasoning `planClaimReply` documents above for the claim-confirm select.
 *
 * One row per element of the outer array. `list-invites` renders one row
 * per pending invite (an accept button beside a decline button, both
 * carrying that invite's id) — see spec §2.5 and `MAX_LISTED_INVITES`,
 * which is what keeps this inside Discord's five-row cap.
 */
export function planRosterButtons(prompt: RosterPrompt | undefined): RosterButtonSpec[][] {
  if (!prompt) return [];
  if (prompt.kind === "confirm-transfer") {
    return [[{ customId: transferCustomId(prompt.factionId, prompt.targetDiscordId), label: "Confirm transfer", style: "danger" }]];
  }
  if (prompt.kind === "confirm-disband") {
    return [[{ customId: disbandCustomId(prompt.factionId), label: "Confirm disband", style: "danger" }]];
  }
  if (prompt.kind === "list-invites") {
    return prompt.invites.map((inv) => [
      { customId: inviteAcceptCustomId(inv.id), label: `Accept ${inv.tag}`, style: "success" as const },
      { customId: inviteDeclineCustomId(inv.id), label: `Decline ${inv.tag}`, style: "danger" as const },
    ]);
  }
  if (prompt.kind === "confirm-rebind") {
    return [[{
      customId: rebindCustomId(prompt.factionId, prompt.poleKey),
      label: "Move our base",
      style: "danger",
    }]];
  }
  // Placeholder for any future prompt kind's button rendering.
  return [];
}

/** The subset of a discord.js `Client` this needs to attempt an invite DM. Structural so tests need no client. */
export type DmClientLike = {
  users: {
    fetch: (discordId: string) => Promise<{
      send: (opts: { content: string; components: ActionRowBuilder<ButtonBuilder>[] }) => Promise<unknown>;
    }>;
  };
};

/** The subset of the inviter's interaction needed to report a failed DM. Structural so tests need no client. */
export type FollowUpLike = { followUp: (opts: { content: string; flags: number }) => Promise<unknown> };

/**
 * Attempts to deliver a `RosterReply.dm` — currently only ever an invite —
 * with its accept/decline buttons attached.
 *
 * ⚠️ A closed DM is ordinary, not an error: the invitation is already
 * durable in the database, and `/faction invites` is the pull route that
 * makes it reachable. What matters is that the INVITER — not the invitee —
 * is told, or they will wait on a friend who never saw anything. See spec
 * §2.5.
 */
export async function deliverInviteDm(
  client: DmClientLike,
  interaction: FollowUpLike,
  dm: NonNullable<RosterReply["dm"]>,
): Promise<void> {
  try {
    const user = await client.users.fetch(dm.discordId);
    await user.send({ content: dm.content, components: [inviteButtons(dm.inviteId)] });
  } catch (err) {
    console.warn("invite DM failed", err);
    await interaction.followUp({ content: dm.onFailure, flags: MessageFlags.Ephemeral });
  }
}

export * from "./notify.js";

/** Injected into `notifyCompleted` so tests need no discord.js client. */
export type NicknameApplier = (
  guildId: string, discordId: string, nickname: string | null,
) => Promise<NicknameOutcome>;

/**
 * `NicknameOutcome` plus one case that belongs only to the caller: no rename
 * was even attempted, either because no `NicknameApplier` was wired (a unit
 * test of the notifier itself, or a bot instance with no Discord client) or
 * because there was no link to read a gamertag from. Distinct from "failed"
 * — that means an attempt was made and Discord refused or errored — so the
 * DM doesn't tell a player something failed when nothing was tried.
 */
export type RenameOutcome = NicknameOutcome | "not-attempted";

/**
 * Player-facing sentence for how the rename went. The link itself is never in
 * question here — this only ever runs after `completeChallenge` has already
 * committed the binding — so every branch leads with that being settled.
 */
function nicknameOutcomeSuffix(outcome: RenameOutcome): string {
  switch (outcome) {
    case "not-attempted":
      return "";
    case "ok":
      return " Your nickname has been set to match.";
    case "is-owner":
      return " Your nickname could not be changed: Discord will not let a bot rename the server owner.";
    case "outranked":
      return " Your nickname could not be changed: the bot's role is below yours, so an admin needs to move it above.";
    case "no-permission":
      return " Your nickname could not be changed: the bot does not have the Manage Nicknames permission.";
    case "failed":
      return " Your nickname could not be changed right now.";
  }
}

/**
 * Tell each player their challenge's outcome, exactly once.
 *
 * Two outcomes reach here: a completion, and a challenge canceled because its
 * target spent the whole emote budget without finishing the sequence (spec
 * §5.3). Both ride the same `notified_at` discipline, so neither is ever sent
 * twice, and neither an ordinary expiry nor a `/link` switch-cancel reaches
 * here at all — they carry no cancel reason. See `pendingNotifications`.
 *
 * `markNotified` runs only after `send` resolves. A send that throws — closed
 * DMs, a deleted channel, a rate limit — leaves the row pending so the next
 * pass retries, rather than marking it done and dropping the message.
 *
 * ⚠️ The rename is attempted here, strictly AFTER the identity link (this
 * only ever runs for challenges `completeChallenge` has already committed).
 * It is wrapped in its OWN try/catch, separate from the `send`/`markNotified`
 * one below: `renameOnLink` calls into a real discord.js permission
 * predicate and guild fetch, which — unlike `applyNickname` itself — are not
 * guaranteed not to throw (a partially-cached `Guild`, for instance). If that
 * escaped into the outer catch, it would land exactly where a failed `send`
 * lands: no DM delivered, the row left pending, retried forever — silently
 * losing the notification over something that was only ever supposed to be
 * best-effort.
 */
export async function notifyCompleted(
  deps: CommandDeps,
  send: Sender,
  loggedFailures: NotifyFailureLog = createNotifyFailureLog(),
  renameOnLink?: NicknameApplier,
): Promise<number> {
  let sent = 0;
  for (const c of await deps.store.pendingNotifications()) {
    try {
      if (c.outcome !== "completed") {
        // Nothing was bound, so there is no rename to attempt and no link to
        // read — only the character they were trying to verify, named so a
        // player with several does not have to guess which attempt died.
        await send({
          discordId: c.discordId,
          channelId: c.channelId,
          content: await lockedOutMessage(deps, c),
        });
        await deps.store.markNotified(c.id, deps.now());
        loggedFailures.delete(c.id);
        sent++;
        continue;
      }
      let outcome: RenameOutcome = "not-attempted";
      if (renameOnLink) {
        try {
          // The link is already committed by the time a challenge appears
          // here, so this lookup exists only to get the gamertag to rename
          // to — it is not a gate on anything.
          const link = await deps.store.findLinkByDiscord(c.discordId);
          if (link) outcome = await renameOnLink(c.guildId, c.discordId, link.gamertag);
        } catch (err) {
          console.warn(`nickname lookup/rename failed for ${c.discordId}`, err);
          outcome = "failed";
        }
      }
      await send({
        discordId: c.discordId,
        channelId: c.channelId,
        content: "Verified — your Discord account is now linked to your character." + nicknameOutcomeSuffix(outcome),
      });
      await deps.store.markNotified(c.id, deps.now());
      // A challenge that got through stops being a candidate for suppression:
      // markNotified normally retires it, but a send that succeeds while
      // markNotified fails must be able to report a later failure.
      loggedFailures.delete(c.id);
      sent++;
    } catch (err) {
      if (!loggedFailures.has(c.id)) {
        console.error(`notify failed for challenge ${c.id}`, err);
        loggedFailures.add(c.id);
      }
    }
  }
  return sent;
}

/**
 * What a player is told when their challenge ran out of emote budget.
 *
 * Names the emote they never reached, which is the difference between an
 * apology and a diagnosis — see the comment on `stuckOn` below, and the
 * `ORDINALS` note on why no count appears.
 */
async function lockedOutMessage(
  deps: CommandDeps,
  c: { targetDayzId: string; sequence: string[]; progressIndex: number },
): Promise<string> {
  // Cosmetic only — a missing player row must not cost the player their
  // message, so fall back to the UID rather than letting this decide anything.
  const name = (await deps.store.playerByDayzId(c.targetDayzId))?.gamertag ?? c.targetDayzId;
  const opening =
    `Your link challenge for **${name}** was canceled: too many emotes were performed ` +
    "before the sequence was completed, so it can no longer be finished.";
  const retry = "Run `/link` again for a fresh sequence, and perform just those emotes, in order.";

  // The emote they stopped at. A player at index 0 never managed the FIRST
  // one, which is a different problem from fumbling the order — it usually
  // means they could not find it on the wheel at all, the way EmoteSOS could
  // not be found before it was demoted. Naming it is what makes this message
  // actionable, and a run of lockouts stuck on one token is how the next
  // unperformable emote in the safe pool becomes visible.
  const stuckOn = c.sequence[c.progressIndex];
  if (stuckOn === undefined) return `${opening} ${retry}`;
  const label = emoteLabel(stuckOn) ?? stuckOn;

  return (
    `${opening} You never performed **${label}** — the ${ordinal(c.progressIndex)} of the ` +
    `${c.sequence.length}. If you cannot find that one on the emote wheel, that is worth ` +
    `saying in the channel: it may be an emote no one can perform.\n\n${retry}`
  );
}

/**
 * ⚠️ Deliberately no count of emotes performed anywhere in the lockout
 * message. The budget is the primary defence against the named target backing
 * into its own sequence by accident (see MAX_POOL_EMOTES_PER_ATTEMPT), and a
 * player who reads a number as a target to optimise against has misunderstood
 * what to do. The missing EMOTE is the actionable fact; the count is not.
 */
const ORDINALS = ["first", "second", "third", "fourth", "fifth", "sixth"];
const ordinal = (i: number): string => ORDINALS[i] ?? `${i + 1}th`;

/** The subset of a discord.js `Client` a `NicknameApplier` needs. Structural so tests need no real client. */
export type NicknameClientLike = { guilds: { fetch(guildId: string): Promise<RealGuildLike> } };
/** discord.js's `Guild` has all of this; kept minimal here so the adapter stays honest about what it uses. */
export type RealGuildLike = {
  ownerId: string;
  members: {
    fetch(userId: string): Promise<{ manageable: boolean; setNickname(nick: string | null): Promise<unknown> }>;
    me: { permissions: { has(perm: bigint): boolean } } | null;
  };
};

/**
 * Adapts a real discord.js `Client` to the `NicknameApplier` shape
 * `notifyCompleted` and `handleUnlink`'s `clearNickname` both take. This is
 * the ONLY place real discord.js types meet `nickname.ts`'s structural
 * `GuildLike` — everything else stays client-free for testing.
 */
export function createNicknameApplier(client: NicknameClientLike): NicknameApplier {
  return async (guildId, discordId, nickname) => {
    let guild: RealGuildLike;
    try {
      guild = await client.guilds.fetch(guildId);
    } catch (err) {
      console.warn(`nickname change failed — could not fetch guild ${guildId}`, err);
      return "failed";
    }
    const guildLike: GuildLike = {
      ownerId: guild.ownerId,
      members: { fetch: (userId) => guild.members.fetch(userId) },
      members_me_permissions_has: () =>
        guild.members.me?.permissions.has(PermissionFlagsBits.ManageNicknames) ?? false,
    };
    return applyNickname(guildLike, discordId, nickname);
  };
}

/**
 * Wraps an async job so a firing is SKIPPED while the previous one is still
 * running, and exposes the in-flight promise so shutdown can await it.
 *
 * ⚠️ Not a nicety. verificationTick reads a consumer cursor at the start and
 * writes it at the end; two overlapping runs both read the same value, and
 * whichever finishes LAST wins the write — so a slow run can move the cursor
 * backwards and cause already-processed events to be replayed.
 *
 * This guards a SINGLE process only. Running two bot instances against one
 * database would need a Postgres advisory lock keyed on the consumer name
 * instead — see the README.
 */
export function guardedRunner(job: () => Promise<void>): {
  fire: () => void;
  inFlight: () => Promise<void> | null;
  skipped: () => number;
} {
  let running: Promise<void> | null = null;
  let skipped = 0;
  return {
    fire: () => {
      if (running) { skipped++; return; }
      // The rejection is swallowed here, not left for callers to handle: the
      // returned promise exists so shutdown can await "is a run still in
      // flight", and forcing every caller to attach a .catch just to avoid an
      // unhandled rejection would be an easy way to reintroduce this bug.
      running = job()
        .catch((err: unknown) => {
          // Logged, not merely swallowed. Callers today wrap their own body in
          // try/catch so this is a dead-letter backstop — but a future caller
          // that forgets would otherwise fail completely silently, with
          // verification quietly doing nothing and no line anywhere saying so.
          console.error("guarded job failed", err);
        })
        .finally(() => { running = null; });
    },
    inFlight: () => running,
    skipped: () => skipped,
  };
}

export async function start(cfg: BotConfig): Promise<void> {
  const db = createClient(cfg.databaseUrl);
  const store = new PgVerificationStore(db);
  const factionStore = new PgFactionStore(db);
  const factionDeps: FactionDeps = {
    store: factionStore, now: () => new Date(), reservationTtlMs: cfg.reservationTtlMs,
  };
  const rosterStore = new PgRosterStore(db);
  const rosterDeps: RosterDeps = {
    store: rosterStore, now: () => new Date(),
    inviteTtlMs: cfg.inviteTtlMs, cooldownMs: cfg.cooldownMs, renameCooldownMs: cfg.renameCooldownMs,
  };
  const rebindDeps: RebindDeps = {
    store: rosterStore,
    rebindStore: new PgRebindStore(db),
    now: () => new Date(),
    rebindCooldownMs: cfg.rebindCooldownMs,
  };
  const ceremonyStore = new PgCeremonyStore(db);
  const dormancyStore = new PgDormancyStore(db);

  try {
    await new REST().setToken(cfg.token).put(
      Routes.applicationGuildCommands(cfg.applicationId, cfg.guildId),
      { body: buildCommands() },
    );
  } catch (err) {
    console.error(
      "Failed to register slash commands. Check that DISCORD_TOKEN is valid, " +
      "DISCORD_APPLICATION_ID and DISCORD_GUILD_ID are correct, and the bot " +
      "was invited with both the `bot` and `applications.commands` scopes.",
      err,
    );
    process.exit(1);
  }

  const client = new Client({ intents: [GatewayIntentBits.Guilds] });

  // Fetching one member and patching a nickname are plain REST calls — this
  // needs no gateway intent beyond the `Guilds` one already requested above.
  const renameOnLink = createNicknameApplier(client);
  const deps: CommandDeps = {
    store, rng: Math.random, now: () => new Date(), challengeTtlMs: cfg.challengeTtlMs,
    clearNickname: (guildId, discordId) => renameOnLink(guildId, discordId, null).then(() => undefined),
  };

  const renderFactionReply = async (
    interaction: { editReply: (opts: InteractionEditReplyOptions) => Promise<unknown> },
    reply: FactionReply,
  ): Promise<void> => {
    const plan = planClaimReply(reply);
    if (plan.kind !== "select") {
      await interaction.editReply({ content: plan.content });
      return;
    }
    const select = new StringSelectMenuBuilder()
      .setCustomId(plan.customId)
      .setMinValues(1)
      .setMaxValues(plan.maxValues)
      .addOptions(plan.options);
    const row = new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(select);
    await interaction.editReply({ content: plan.content, components: [row] });
  };

  const renderRosterReply = async (
    interaction: { editReply: (opts: InteractionEditReplyOptions) => Promise<unknown>; followUp: FollowUpLike["followUp"] },
    reply: RosterReply,
  ): Promise<void> => {
    const rows = planRosterButtons(reply.prompt).map((row) =>
      new ActionRowBuilder<ButtonBuilder>().addComponents(row.map((b) =>
        new ButtonBuilder().setCustomId(b.customId).setLabel(b.label)
          .setStyle(b.style === "success" ? ButtonStyle.Success : ButtonStyle.Danger),
      )));
    await interaction.editReply({ content: reply.content, components: rows });

    if (reply.dm) {
      await deliverInviteDm(client, interaction, reply.dm);
    }
  };

  client.on("interactionCreate", async (interaction) => {
    if (interaction.isAutocomplete()) {
      if (interaction.commandName === "faction") {
        const focused = interaction.options.getFocused(true);
        try {
          if (focused.name === "flag") {
            await interaction.respond(flagSuggestions(String(focused.value)).map((f) => ({ name: f, value: f })));
          } else if (focused.name === "server") {
            const memberships = await rosterStore.membershipsFor(interaction.user.id);
            await interaction.respond(serverChoices(memberships));
          }
        } catch (err) {
          // The autocomplete window is also short-lived; a dropped response
          // just means no suggestions this keystroke, not a broken command.
          console.error(`${focused.name} autocomplete failed`, err);
        }
      } else if (interaction.commandName === "link" && interaction.options.getFocused(true).name === LINK_GAMERTAG_OPTION) {
        const focused = interaction.options.getFocused(true);
        try {
          const candidates = await store.recentUnlinkedPlayers(50);
          await interaction.respond(playerSuggestions(candidates, String(focused.value)));
        } catch (err) {
          // Same short response window as the /faction autocompletes above:
          // a dropped response just means no suggestions this keystroke.
          console.error(`${focused.name} autocomplete failed`, err);
        }
      }
      return;
    }

    if (interaction.isChatInputCommand()) {
      try {
        if (interaction.commandName === "faction") {
          const sub = interaction.options.getSubcommand();
          if (sub === "claim") {
            // ⚠️ handleFactionClaim makes four or more database round trips;
            // Discord's initial-response window is 3 seconds. Without the
            // defer the first claim can fail with "The application did not
            // respond" AFTER the draft row was already written.
            await interaction.deferReply({ flags: MessageFlags.Ephemeral });
            const reply = await handleFactionClaim(factionDeps, interaction.user.id, {
              name: interaction.options.getString("name", true),
              tag: interaction.options.getString("tag", true),
              texture: interaction.options.getString("flag", true),
            });
            await renderFactionReply(interaction, reply);
            return;
          }

          // ⚠️ Every roster handler makes at least two database round trips
          // (membershipsFor plus the write), so this defers up front for the
          // same reason claim does — see the comment above.
          // ⚠️ Every roster reply is ephemeral, `info` and `roster` included:
          // the info card carries the faction's pole coordinates, which is a
          // raid target, and a public reply handed it to the whole channel.
          // `RosterReply.ephemeral` is typed as the literal `true` so the
          // handlers cannot disagree with this line.
          await interaction.deferReply({ flags: MessageFlags.Ephemeral });

          const serverId = interaction.options.getInteger("server");
          const userId = (name: string) => interaction.options.getUser(name, true).id;

          let reply: RosterReply;
          switch (sub) {
            case "invite":
              reply = await handleFactionInvite(rosterDeps, interaction.user.id, { serverId, inviteeDiscordId: userId("user") });
              break;
            case "invites":
              reply = await handleFactionInvites(rosterDeps, interaction.user.id);
              break;
            case "kick":
              reply = await handleFactionKick(rosterDeps, interaction.user.id, { serverId, targetDiscordId: userId("user") });
              break;
            case "leave":
              reply = await handleFactionLeave(rosterDeps, interaction.user.id, serverId);
              break;
            case "promote":
              reply = await handleFactionPromote(rosterDeps, interaction.user.id, { serverId, targetDiscordId: userId("user") });
              break;
            case "demote":
              reply = await handleFactionDemote(rosterDeps, interaction.user.id, { serverId, targetDiscordId: userId("user") });
              break;
            case "transfer":
              reply = await handleFactionTransfer(rosterDeps, interaction.user.id, { serverId, targetDiscordId: userId("user") });
              break;
            case "disband":
              reply = await handleFactionDisband(rosterDeps, interaction.user.id, serverId);
              break;
            case "rename":
              reply = await handleFactionRename(rosterDeps, interaction.user.id, { serverId, name: interaction.options.getString("name", true) });
              break;
            case "rebind":
              reply = await handleFactionRebind(rebindDeps, interaction.user.id, serverId);
              break;
            case "info":
              reply = await handleFactionInfo(rosterDeps, interaction.user.id, interaction.options.getString("name"), serverId);
              break;
            case "roster":
              reply = await handleFactionRoster(rosterDeps, interaction.user.id, interaction.options.getString("name"), serverId);
              break;
            default:
              // Unreachable against a current registration; a stale guild
              // command would land here, and after the defer above a bare
              // return would hang the interaction. The catch apologises.
              throw new Error(`unknown /faction subcommand: ${sub}`);
          }
          await renderRosterReply(interaction, reply);
          return;
        }

        const reply = await routeInteraction(deps, {
          commandName: interaction.commandName,
          userId: interaction.user.id,
          guildId: interaction.guildId,
          channelId: interaction.channelId,
          // Only /link declares it; getString returns null for the others.
          targetDayzId: interaction.options.getString(LINK_GAMERTAG_OPTION),
          newSequence: interaction.options.getBoolean(LINK_NEW_SEQUENCE_OPTION),
        });
        if (!reply) return;
        await interaction.reply({ content: reply.content, flags: MessageFlags.Ephemeral });
      } catch (err) {
        // ⚠️ discord.js does not await this listener, so an uncaught throw here
        // becomes an unhandled rejection and Node terminates the process. An
        // expired interaction token — which is only a 3-second window — would
        // take the bot down for every player. Log and drop the one interaction.
        console.error(`interaction ${interaction.commandName} failed`, err);
        // ...but if we already deferred, dropping it silently leaves the
        // player on "thinking" forever. Say something.
        await apologiseForFailure(interaction);
      }
      return;
    }

    if (interaction.isStringSelectMenu()) {
      try {
        await respondToClaimConfirm(factionDeps, {
          customId: interaction.customId,
          userId: interaction.user.id,
          values: interaction.values,
          deferReply: (opts) => interaction.deferReply(opts),
          editReply: (opts) => interaction.editReply(opts),
        });
      } catch (err) {
        console.error(`component ${interaction.customId} failed`, err);
        // `respondToClaimConfirm` defers before it touches the store, so
        // logging and dropping leaves the player on "thinking" forever.
        await apologiseForFailure(interaction);
      }
      return;
    }

    if (interaction.isButton()) {
      try {
        const buttonLike = {
          customId: interaction.customId,
          userId: interaction.user.id,
          deferReply: (opts: { flags?: number }) => interaction.deferReply(opts),
          editReply: (opts: { content: string }) => interaction.editReply(opts),
        };
        const handled = await routeRosterButton(rosterDeps, buttonLike);
        if (!handled) await routeRebindButton(rebindDeps, buttonLike);
      } catch (err) {
        console.error(`component ${interaction.customId} failed`, err);
        // Same as above, and this is the path accept/decline/transfer/disband
        // ride on — the one most likely to throw from the store.
        await apologiseForFailure(interaction);
      }
    }
  });

  const send: Sender = async (n) => {
    // DM first; fall back to the channel /link was run in, because a player
    // with closed DMs would otherwise never learn they succeeded.
    try {
      const user = await client.users.fetch(n.discordId);
      await user.send(n.content);
    } catch {
      const channel = await client.channels.fetch(n.channelId);
      if (channel?.isSendable()) await channel.send(`<@${n.discordId}> ${n.content}`);
      else throw new Error(`no reachable surface for ${n.discordId}`);
    }
  };

  // One log per bot instance, for the life of that instance.
  const notifyFailures = createNotifyFailureLog();
  const ceremonyFailures = createNotifyFailureLog();

  let timer: NodeJS.Timeout | undefined;

  const runner = guardedRunner(async () => {
    // ⚠️ FIRST, and in its own try/catch. `/link`'s autocomplete can only
    // offer characters this projection has recorded, so a player who has
    // just been seen in game is unlinkable until it runs. A failure here
    // must not stop verification — a stale menu is survivable, a halted
    // tick is not.
    try {
      const p = await runPlayerProjection(db);
      if (p.upserted > 0) console.log(`players projected ${p.upserted} of ${p.scanned} events`);
    } catch (err) {
      console.error("player projection failed", err);
    }

    try {
      const r = await verificationTick(db, store);
      if (r.verified > 0 || r.alreadyLinked > 0) {
        console.log(`verified ${r.verified}, refused ${r.alreadyLinked} (already linked)`);
      }
      await notifyCompleted(deps, send, notifyFailures, renameOnLink);
    } catch (err) {
      // A thrown tick must not kill the interval and silently stop all verification.
      console.error("tick failed", err);
    }

    // Each of the two ceremony steps gets its own try/catch: a failing
    // detector must not stop ceremony DMs, and vice versa.
    try {
      const c = await ceremonyTick(db, ceremonyStore, { now: new Date() });
      if (c.detected > 0 || c.activated > 0 || c.lapsed > 0) {
        console.log(`ceremonies detected ${c.detected}, activated ${c.activated}, lapsed ${c.lapsed}`);
      }
    } catch (err) {
      console.error("ceremony tick failed", err);
    }
    try {
      await notifyCeremonies(db, send, () => new Date(), ceremonyFailures);
    } catch (err) {
      console.error("ceremony notify failed", err);
    }

    // ⚠️ Its own try/catch, like every other step in this job: a throw here
    // must not stop verification or ceremony DMs. Runs last because nothing
    // else depends on it — supplies are read from status by a different
    // process on its own schedule.
    try {
      const d = await dormancyTick(dormancyStore, {
        now: new Date(),
        windows: {
          dormantAfterMs: cfg.dormantAfterMs,
          disbandAfterDormantMs: cfg.disbandAfterDormantMs,
        },
        onError: (factionId, err) => console.error(`dormancy failed for faction ${factionId}`, err),
      });
      if (d.dormant > 0 || d.revived > 0 || d.disbanded > 0 || d.stamped > 0) {
        console.log(
          `dormancy: ${d.dormant} dormant, ${d.revived} revived, ` +
          `${d.disbanded} disbanded, ${d.stamped} stamped, of ${d.examined} examined`,
        );
      }
      // ⚠️ Its own line, at error level, and deliberately not folded into the
      // counts above. A paused clock means a server with dormant factions on
      // it produced no events this tick — an ingest problem wearing dormancy's
      // clothes. Folding it in with the routine transitions is how it stayed
      // invisible: an operator cannot distinguish "nothing was due" from
      // "disbands are being withheld because the worker is down" unless
      // something says so out loud.
      if (d.paused > 0) {
        console.error(
          `dormancy: disband countdown paused for ${d.paused} faction(s) — their server has ` +
          `produced no events in ${cfg.dormantAfterMs}ms, so ingest is presumably down. ` +
          "Supplies stay cut while dormant, but nothing will be disbanded until events resume.",
        );
      }
      await notifyDormancy(d.notices, send, (n, err) =>
        console.error(`dormancy DM failed for faction ${n.factionId}`, err));
    } catch (err) {
      console.error("dormancy tick failed", err);
    }
  });

  client.once("clientReady", () => {
    console.log(`bot ready as ${client.user?.tag}`);
    timer = setInterval(() => runner.fire(), cfg.tickIntervalMs);
  });

  const SHUTDOWN_GRACE_MS = 15_000;
  let shuttingDown = false;

  const shutdown = async (signal: string): Promise<void> => {
    if (shuttingDown) return; // a second Ctrl-C must not re-enter
    shuttingDown = true;
    console.log(`${signal} received, shutting down`);
    if (timer) clearInterval(timer);

    // clearInterval only prevents the NEXT firing. Await the run already in
    // flight so it is not torn down mid-transaction, but bound the wait so a
    // wedged tick cannot block the container stop forever.
    const running = runner.inFlight();
    if (running) {
      let grace: NodeJS.Timeout | undefined;
      await Promise.race([
        running,
        new Promise<void>((resolve) => {
          grace = setTimeout(resolve, SHUTDOWN_GRACE_MS);
          grace.unref(); // must not itself hold the event loop open
        }),
      ]);
      if (grace) clearTimeout(grace);
    }

    await client.destroy();
    process.exit(0);
  };
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("SIGINT", () => void shutdown("SIGINT"));

  await client.login(cfg.token);
}
