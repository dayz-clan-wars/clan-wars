import {
  ActionRowBuilder, ModalBuilder, SlashCommandBuilder, TextInputBuilder, TextInputStyle,
} from "discord.js";
import { VAULT_CODE_DIGITS } from "@factions/domain";
import { discordCopy, discordVaultCopy, REFUSAL, revealedCopy, rotatedCopy } from "@factions/copy";
import { VAULT_NAME_MAX, VAULT_NOTE_MAX } from "@factions/roster";
import { vaultEmbed } from "./embeds/vault.js";
import { idOf, roleOf } from "./parse.js";
import { confirmReply, modalId } from "./confirm.js";
import type { AutocompleteSource, CommandGroup, ComponentHandler, Handler, ModalHandler } from "./types.js";

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

const PICK_A_LOCK = "Pick a lock from the list.";

/**
 * ⚠️ `VAULT_TABLES.reveal.ok` ("Revealed.") is a placeholder — its own
 * comment in `packages/copy/src/vault.ts` says it must never reach a
 * player, because `revealLock`'s real success path always carries a code.
 * `outcome === "ok" && code === null` should be unreachable; treat it as a
 * failure rather than fall through to that placeholder sentence.
 *
 * A bot-internal failure sentence, not a domain outcome — the same
 * category as `HANDLER_FAILED` and `NOT_YOURS` in `route.ts`, which is
 * why it lives here rather than in `@factions/copy`'s outcome tables.
 */
const REVEAL_FAILED = "Something went wrong revealing that code. Try again.";

/**
 * `/vault reveal`.
 *
 * ⚠️ The only place in `apps/bot` that holds a code. It goes into
 * `Reply.content` and nowhere else — no embed, no log line, no custom id, no
 * autocomplete label. The lock's name is read from `vaultFor` (which has
 * already rank-filtered) purely so the sentence can name what was revealed;
 * `revealLock` is still the permission check and can refuse after that read.
 */
const reveal: Handler = async (ctx, input) => {
  const lockId = idOf(input.string("lock"));
  if (lockId === null) return { content: PICK_A_LOCK, ephemeral: true };
  const state = await ctx.roster.vaultFor(input.actorDiscordId);
  if (typeof state === "string") return { content: REFUSAL[state], ephemeral: true };
  const { outcome, code } = await ctx.roster.revealLock(input.actorDiscordId, lockId);
  if (outcome === "ok" && code !== null) {
    const name = state.locks.find((l) => l.id === lockId)?.name ?? "That lock";
    return { content: revealedCopy(name, code), ephemeral: true };
  }
  return { content: outcome === "ok" ? REVEAL_FAILED : discordVaultCopy("reveal", outcome), ephemeral: true };
};

const confirm: Handler = async (ctx, input) => {
  const lockId = idOf(input.string("lock"));
  if (lockId === null) return { content: PICK_A_LOCK, ephemeral: true };
  return { content: discordVaultCopy("confirm", await ctx.roster.confirmLock(input.actorDiscordId, lockId)), ephemeral: true };
};

/** R2: the slash command writes nothing. The press is the write. */
const del: Handler = async (_ctx, input) => {
  const lockId = idOf(input.string("lock"));
  if (lockId === null) return { content: PICK_A_LOCK, ephemeral: true };
  return confirmReply("vault-del", input.actorDiscordId, discordVaultCopy("delete", "unconfirmed"), String(lockId));
};

const pressDelete: ComponentHandler = async (ctx, a) => {
  const lockId = idOf(a.arg);
  if (lockId === null) return { content: PICK_A_LOCK, ephemeral: true };
  return { content: discordVaultCopy("delete", await ctx.roster.deleteLock(a.actorDiscordId, lockId)), ephemeral: true };
};

/** R2 and R3: a Confirm button, one lock or every lock, and never a chosen code. */
const rotate: Handler = async (_ctx, input) => {
  const raw = input.string("lock");
  const target = raw === "all" ? "all" : idOf(raw);
  if (target === null) return { content: PICK_A_LOCK, ephemeral: true };
  return confirmReply("vault-rot", input.actorDiscordId, discordVaultCopy("rotate", "unconfirmed"), String(target));
};

const pressRotate: ComponentHandler = async (ctx, a) => {
  const target = a.arg === "all" ? "all" : idOf(a.arg);
  if (target === null) return { content: PICK_A_LOCK, ephemeral: true };
  const { outcome, rotated } = await ctx.roster.rotateLocks(a.actorDiscordId, target);
  if (outcome !== "ok") return { content: discordVaultCopy("rotate", outcome), ephemeral: true };
  // ⚠️ P2: the count needs a sentence around it, and a sentence a player
  // reads is copy — so it lives in `packages/copy`, not here.
  return { content: rotatedCopy(rotated), ephemeral: true };
};

/** `/vault rotate`'s option: every lock the rank may see, plus "all". */
export const locksOrAll: AutocompleteSource = async (ctx, a) => [
  { name: "Every lock", value: "all" },
  ...(await locks(ctx, a)),
];

export const vaultGroup: CommandGroup = {
  command: new SlashCommandBuilder()
    .setName("vault")
    .setDescription("Your clan's lock codes")
    .addSubcommand((s) => s.setName("list").setDescription("The locks your rank may see"))
    .addSubcommand((s) => s.setName("add").setDescription("Add a lock")
      .addStringOption((o) => o.setName("minrole").setDescription("Who may see the code").setRequired(true).addChoices(...MIN_ROLE_CHOICES)))
    .addSubcommand((s) => s.setName("edit").setDescription("Rename a lock or change who may see it")
      .addStringOption((o) => o.setName("lock").setDescription("Which lock").setRequired(true).setAutocomplete(true))
      .addStringOption((o) => o.setName("minrole").setDescription("Who may see the code").setRequired(true).addChoices(...MIN_ROLE_CHOICES)))
    .addSubcommand((s) => s.setName("reveal").setDescription("Show a code — only to you")
      .addStringOption((o) => o.setName("lock").setDescription("Which lock").setRequired(true).setAutocomplete(true)))
    .addSubcommand((s) => s.setName("confirm").setDescription("Say the new code is set on the lock in game")
      .addStringOption((o) => o.setName("lock").setDescription("Which lock").setRequired(true).setAutocomplete(true)))
    .addSubcommand((s) => s.setName("delete").setDescription("Delete a lock")
      .addStringOption((o) => o.setName("lock").setDescription("Which lock").setRequired(true).setAutocomplete(true)))
    .addSubcommand((s) => s.setName("rotate").setDescription("Give a lock a new code")
      .addStringOption((o) => o.setName("lock").setDescription("Which lock, or every lock").setRequired(true).setAutocomplete(true))),
  specs: [
    { path: "vault list", handler: list },
    { path: "vault add", handler: add, opensModal: true },
    { path: "vault edit", handler: edit, opensModal: true, autocomplete: { lock: locks } },
    { path: "vault reveal", handler: reveal, autocomplete: { lock: locks } },
    { path: "vault confirm", handler: confirm, autocomplete: { lock: locks } },
    { path: "vault delete", handler: del, autocomplete: { lock: locks } },
    { path: "vault rotate", handler: rotate, autocomplete: { lock: locksOrAll } },
  ],
  modals: { "vault-add": submitAdd, "vault-edit": submitEdit },
  components: { "vault-del": pressDelete, "vault-rot": pressRotate },
};
