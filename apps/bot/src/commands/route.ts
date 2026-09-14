import {
  MessageFlags,
  type AutocompleteInteraction,
  type ChatInputCommandInteraction,
  type Interaction,
  type MessageComponentInteraction,
  type ModalSubmitInteraction,
} from "discord.js";
import { COMPONENTS, MODALS, MODAL_OPENERS, SPECS, UPDATERS } from "./index.js";
import { parseCustomId } from "./confirm.js";
import type { CommandInput, Ctx, Reply } from "./types.js";

/** What an unknown command or a stale client gets: a sentence, never discord.js's default failure. */
const UNKNOWN = "That command is no longer available — check the site.";

/**
 * What a player sees when their handler throws after the interaction was
 * deferred. Generic on purpose — the real cause belongs in the operator's
 * log, not in a player-facing message.
 */
const HANDLER_FAILED = "Something went wrong running that command. Try again in a moment.";

/** A pressed button or a submitted modal whose custom id names someone else. */
const NOT_YOURS = "That button is not yours — run the command yourself.";

/**
 * ⚠️ Never `console.error(err)` a discord.js REST failure directly. Its
 * `DiscordAPIError`/`HTTPError` (`@discordjs/rest`) carry the whole failed
 * request as `err.requestBody = { files, json: body }` — and the request
 * that fails here is the `editReply` call below, whose `json.content` is
 * whatever the handler answered with. For `/vault reveal` that content IS a
 * lock code. Log only the diagnosis — name, message, and `code`/`status`
 * when present — and nothing shaped like a request or response body.
 */
export function safeErrorInfo(err: unknown): Record<string, unknown> {
  if (err && typeof err === "object") {
    const e = err as { name?: unknown; message?: unknown; code?: unknown; status?: unknown };
    return { name: e.name, message: e.message, code: e.code, status: e.status };
  }
  return { value: String(err) };
}

/** The one place a discord.js interaction is unpacked into a handler's input. */
function inputFor(i: ChatInputCommandInteraction): CommandInput {
  return {
    actorDiscordId: i.user.id,
    string: (n) => i.options.getString(n),
    integer: (n) => i.options.getInteger(n),
    boolean: (n) => i.options.getBoolean(n),
    user: (n) => i.options.getUser(n)?.id ?? null,
  };
}

export function pathOf(commandName: string, subcommand: string | null): string {
  return subcommand ? `${commandName} ${subcommand}` : commandName;
}

/**
 * Runs `run` and edits the (already-deferred) interaction with what it
 * returns; a throw is caught and turned into `HANDLER_FAILED` instead of
 * leaving the player staring at "thinking…" forever (Ruling 10). Shared by
 * all three acknowledged paths — chat input, component and modal — so that
 * invariant cannot be forgotten by a new one.
 *
 * ⚠️ Clears `components: []` on every edit. Without this, a failed confirm
 * (or any handler that throws) leaves the pressed button's row on the
 * message, live for another press.
 */
async function finish(
  i: ChatInputCommandInteraction | MessageComponentInteraction | ModalSubmitInteraction,
  run: () => Promise<Reply>,
  label: string,
): Promise<void> {
  let reply: Reply;
  try {
    reply = await run();
  } catch (err) {
    console.error(`handler failed for ${label}`, safeErrorInfo(err));
    // ⚠️ This editReply's own body is generic (`HANDLER_FAILED`), never a
    // secret — but it can still throw (rate limit, unknown message, 5xx),
    // and that throw must not go unlogged or escape uncaught either.
    await i.editReply({ content: HANDLER_FAILED, embeds: [], components: [] })
      .catch((editErr: unknown) => console.error(`edit reply failed for ${label}`, safeErrorInfo(editErr)));
    return;
  }
  // ⚠️ The one place a leaked lock code could reach a log line: this
  // editReply's request body is `reply.content`, and for `/vault reveal`
  // that IS a lock code. If the Discord API call itself fails, the thrown
  // error carries that body — see `safeErrorInfo`'s comment. Never log the
  // caught error directly here.
  await i.editReply({ content: reply.content, embeds: reply.embeds ?? [], components: reply.components ?? [] })
    .catch((err: unknown) => console.error(`edit reply failed for ${label}`, safeErrorInfo(err)));
}

export async function handleChatInput(ctx: Ctx, i: ChatInputCommandInteraction): Promise<void> {
  const path = pathOf(i.commandName, i.options.getSubcommand(false));
  const spec = SPECS.get(path);
  if (!spec) return;
  // ⚠️ Before the defer, for the same reason `handleComponent` has this
  // branch: a modal cannot be shown on an acknowledged interaction.
  if (spec.opensModal) {
    const reply = await spec.handler(ctx, inputFor(i));
    if (reply.modal) { await i.showModal(reply.modal); return; }
    // ⚠️ Same invariant as the component opener: a non-modal reply from an
    // opener carries `content` only. Embeds and components are dropped here
    // silently — do not return them from an `opensModal` handler.
    await i.reply({ content: reply.content ?? UNKNOWN, flags: MessageFlags.Ephemeral });
    return;
  }
  // ⚠️ Defer first. A handler runs one or more database round trips and
  // Discord kills an un-acknowledged interaction after 3 seconds; the reply
  // below then edits the deferred message instead of racing that deadline.
  await i.deferReply({ flags: MessageFlags.Ephemeral });
  await finish(i, () => spec.handler(ctx, inputFor(i)), `/${path}`);
}

export async function handleAutocomplete(ctx: Ctx, i: AutocompleteInteraction): Promise<void> {
  const focused = i.options.getFocused(true);
  const spec = SPECS.get(pathOf(i.commandName, i.options.getSubcommand(false)));
  const source = spec?.autocomplete?.[focused.name];
  if (!source) { await i.respond([]); return; }
  const choices = await source(ctx, { actorDiscordId: i.user.id, value: String(focused.value ?? "") });
  // Discord rejects more than 25, and a name over 100 characters.
  await i.respond(choices.slice(0, 25).map((c) => ({ name: c.name.slice(0, 100), value: c.value })));
}

export async function handleComponent(ctx: Ctx, i: MessageComponentInteraction): Promise<void> {
  const parsed = parseCustomId(i.customId);
  if (!parsed || parsed.kind !== "c") return;
  // ⚠️ Before the defer: a handler that opens a modal cannot have
  // acknowledged the interaction first (see `modalOpeners` on `CommandGroup`).
  if (MODAL_OPENERS.has(parsed.action) && parsed.actorDiscordId === i.user.id) {
    const opener = COMPONENTS.get(parsed.action);
    if (opener) {
      const reply = await opener(ctx, { actorDiscordId: i.user.id, arg: parsed.arg, values: [] });
      if (reply.modal) { await i.showModal(reply.modal); return; }
      // ⚠️ INVARIANT: a modal-opener's non-modal reply carries `content`
      // only — `embeds`/`components` are dropped here, silently, with no
      // error. This is harmless today because every listed opener (see
      // `modalOpeners` on `CommandGroup`) can only return a modal or a bare
      // content string. `Reply` itself still permits embeds on this path, so
      // if a future opener ever returns one, it will vanish with nothing to
      // say why — do not add embeds/components to an opener's reply without
      // widening this branch to forward them.
      await i.reply({ content: reply.content ?? UNKNOWN, flags: MessageFlags.Ephemeral });
      return;
    }
  }
  const inPlace = UPDATERS.has(parsed.action);
  if (inPlace) await i.deferUpdate(); else await i.deferReply({ flags: MessageFlags.Ephemeral });
  // ⚠️ A button is never a permission (R2): re-check the presser against the
  // actor named in the custom id even though the message is ephemeral and in
  // practice only that actor can see the button at all.
  if (parsed.actorDiscordId !== i.user.id) {
    await i.editReply({ content: NOT_YOURS, embeds: [], components: [] });
    return;
  }
  const handler = COMPONENTS.get(parsed.action);
  if (!handler) {
    await i.editReply({ content: UNKNOWN, embeds: [], components: [] });
    return;
  }
  await finish(i, () => handler(ctx, {
    actorDiscordId: i.user.id,
    arg: parsed.arg,
    values: i.isStringSelectMenu() ? i.values : [],
  }), `component ${parsed.action}`);
}

export async function handleModalSubmit(ctx: Ctx, i: ModalSubmitInteraction): Promise<void> {
  const parsed = parseCustomId(i.customId);
  if (!parsed || parsed.kind !== "m") return;
  await i.deferReply({ flags: MessageFlags.Ephemeral });
  // ⚠️ A button is never a permission (R2): same re-check as `handleComponent`.
  if (parsed.actorDiscordId !== i.user.id) {
    await i.editReply({ content: NOT_YOURS, embeds: [], components: [] });
    return;
  }
  const handler = MODALS.get(parsed.action);
  if (!handler) {
    await i.editReply({ content: UNKNOWN, embeds: [], components: [] });
    return;
  }
  await finish(i, () => handler(ctx, {
    actorDiscordId: i.user.id,
    arg: parsed.arg,
    field: (n) => i.fields.getTextInputValue(n),
  }), `modal ${parsed.action}`);
}

/**
 * The bot's whole interaction surface.
 *
 * ⚠️ discord.js does not await this listener's caller; an uncaught throw is
 * an unhandled rejection that takes the bot down. `discord.ts` keeps the
 * try/catch that logs and drops one interaction — do not move it in here and
 * do not remove it.
 */
export async function routeInteraction(ctx: Ctx, interaction: Interaction): Promise<boolean> {
  if (interaction.isAutocomplete()) {
    await handleAutocomplete(ctx, interaction);
    return true;
  }
  if (interaction.isChatInputCommand()) {
    const path = pathOf(interaction.commandName, interaction.options.getSubcommand(false));
    if (!SPECS.has(path)) return false;
    await handleChatInput(ctx, interaction);
    return true;
  }
  if (interaction.isMessageComponent()) {
    const parsed = parseCustomId(interaction.customId);
    if (!parsed || parsed.kind !== "c") return false; // R5: not ours, leave it to discord.ts
    await handleComponent(ctx, interaction);
    return true;
  }
  if (interaction.isModalSubmit()) {
    const parsed = parseCustomId(interaction.customId);
    if (!parsed || parsed.kind !== "m") return false;
    await handleModalSubmit(ctx, interaction);
    return true;
  }
  return false;
}

export { UNKNOWN };
