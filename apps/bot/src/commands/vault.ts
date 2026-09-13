import {
  ActionRowBuilder, ModalBuilder, SlashCommandBuilder, TextInputBuilder, TextInputStyle,
} from "discord.js";
import { VAULT_CODE_DIGITS } from "@factions/domain";
import { discordCopy, discordVaultCopy, REFUSAL } from "@factions/copy";
import { VAULT_NAME_MAX, VAULT_NOTE_MAX } from "@factions/roster";
import { vaultEmbed } from "./embeds/vault.js";
import { idOf, roleOf } from "./parse.js";
import { modalId } from "./confirm.js";
import type { AutocompleteSource, CommandGroup, Handler, ModalHandler } from "./types.js";

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

const MIN_ROLE_CHOICES = [
  { name: "Members and up", value: "member" },
  { name: "Officers and the leader", value: "officer" },
  { name: "The leader only", value: "leader" },
] as const;

function textRow(id: string, label: string, style: TextInputStyle, max: number, required: boolean, value?: string) {
  const input = new TextInputBuilder().setCustomId(id).setLabel(label).setStyle(style).setMaxLength(max).setRequired(required);
  if (value) input.setValue(value);
  return new ActionRowBuilder<TextInputBuilder>().addComponents(input);
}

/**
 * `/vault add` — the code goes in the modal, never in a slash option (spec
 * §4.1). A slash option is echoed into the channel's command bar while it is
 * being typed and persists in Discord's client-side command history; a modal
 * field is neither.
 *
 * ⚠️ `opensModal`, so this runs BEFORE any acknowledgement and must stay
 * free of database work.
 */
const add: Handler = async (_ctx, input) => {
  const minRole = roleOf(input.string("minrole"));
  if (!minRole) return { content: discordCopy("input", "bad-input"), ephemeral: true };
  const modal = new ModalBuilder()
    .setCustomId(modalId("vault-add", input.actorDiscordId, minRole))
    .setTitle("Add a lock")
    .addComponents(
      textRow("name", "What it locks", TextInputStyle.Short, VAULT_NAME_MAX, true),
      textRow("note", "Note (optional)", TextInputStyle.Paragraph, VAULT_NOTE_MAX, false),
      textRow("code", `Code (${VAULT_CODE_DIGITS} digits — blank to generate)`, TextInputStyle.Short, VAULT_CODE_DIGITS, false),
    );
  return { modal, ephemeral: true };
};

const submitAdd: ModalHandler = async (ctx, a) => {
  const minRole = roleOf(a.arg);
  if (!minRole) return { content: discordCopy("input", "bad-input"), ephemeral: true };
  const code = a.field("code").trim();
  const note = a.field("note").trim();
  const { outcome } = await ctx.roster.addLock(a.actorDiscordId, {
    name: a.field("name").trim(),
    note: note === "" ? null : note,
    minRole,
    ...(code === "" ? {} : { code }),
  });
  return { content: discordVaultCopy("add", outcome), ephemeral: true };
};

/**
 * `/vault edit` — prefilled from the lock as it stands, because `editLock`
 * overwrites name, note and rank together and a player re-gating a lock
 * should not have to retype its description.
 *
 * ⚠️ `opensModal`: one indexed read (`vaultFor`) before `showModal`, and no
 * more. Discord gives three seconds and there is no defer to fall back on.
 */
const edit: Handler = async (ctx, input) => {
  const minRole = roleOf(input.string("minrole"));
  const lockId = idOf(input.string("lock"));
  if (!minRole || lockId === null) return { content: discordCopy("input", "bad-input"), ephemeral: true };
  const state = await ctx.roster.vaultFor(input.actorDiscordId);
  if (typeof state === "string") return { content: REFUSAL[state], ephemeral: true };
  const current = state.locks.find((l) => l.id === lockId);
  if (!current) return { content: discordVaultCopy("edit", "gone"), ephemeral: true };
  const modal = new ModalBuilder()
    .setCustomId(modalId("vault-edit", input.actorDiscordId, `${lockId}.${minRole}`))
    .setTitle("Edit a lock")
    .addComponents(
      textRow("name", "What it locks", TextInputStyle.Short, VAULT_NAME_MAX, true, current.name),
      textRow("note", "Note (optional)", TextInputStyle.Paragraph, VAULT_NOTE_MAX, false, current.note ?? undefined),
    );
  return { modal, ephemeral: true };
};

const submitEdit: ModalHandler = async (ctx, a) => {
  // `arg` is "<lockId>.<minRole>" (R4). Both halves are client-supplied and
  // both are validated: neither is trusted to be what we wrote.
  const [rawId, rawRole] = (a.arg ?? "").split(".");
  const lockId = idOf(rawId ?? null);
  const minRole = roleOf(rawRole ?? null);
  if (lockId === null || !minRole) return { content: discordCopy("input", "bad-input"), ephemeral: true };
  const note = a.field("note").trim();
  const outcome = await ctx.roster.editLock(a.actorDiscordId, {
    lockId, name: a.field("name").trim(), note: note === "" ? null : note, minRole,
  });
  return { content: discordVaultCopy("edit", outcome), ephemeral: true };
};

export const vaultGroup: CommandGroup = {
  command: new SlashCommandBuilder()
    .setName("vault")
    .setDescription("Your clan's lock codes")
    .addSubcommand((s) => s.setName("list").setDescription("The locks your rank may see"))
    .addSubcommand((s) => s.setName("add").setDescription("Add a lock")
      .addStringOption((o) => o.setName("minrole").setDescription("Who may see the code").setRequired(true).addChoices(...MIN_ROLE_CHOICES)))
    .addSubcommand((s) => s.setName("edit").setDescription("Rename a lock or change who may see it")
      .addStringOption((o) => o.setName("lock").setDescription("Which lock").setRequired(true).setAutocomplete(true))
      .addStringOption((o) => o.setName("minrole").setDescription("Who may see the code").setRequired(true).addChoices(...MIN_ROLE_CHOICES))),
  specs: [
    { path: "vault list", handler: list },
    { path: "vault add", handler: add, opensModal: true },
    { path: "vault edit", handler: edit, opensModal: true, autocomplete: { lock: locks } },
  ],
  modals: { "vault-add": submitAdd, "vault-edit": submitEdit },
};
