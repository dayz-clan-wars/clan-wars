import { MessageFlags, type AutocompleteInteraction, type ChatInputCommandInteraction, type Interaction } from "discord.js";
import { SPECS } from "./index.js";
import type { CommandInput, Ctx, Reply } from "./types.js";

/** What an unknown command or a stale client gets: a sentence, never discord.js's default failure. */
const UNKNOWN = "That command is no longer available — check the site.";

/**
 * What a player sees when their handler throws after the interaction was
 * deferred. Generic on purpose — the real cause belongs in the operator's
 * log, not in a player-facing message.
 */
const HANDLER_FAILED = "Something went wrong running that command. Try again in a moment.";

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

export async function handleChatInput(ctx: Ctx, i: ChatInputCommandInteraction): Promise<void> {
  const spec = SPECS.get(pathOf(i.commandName, i.options.getSubcommand(false)));
  if (!spec) return;
  // ⚠️ Defer first. A handler runs one or more database round trips and
  // Discord kills an un-acknowledged interaction after 3 seconds; the reply
  // below then edits the deferred message instead of racing that deadline.
  await i.deferReply({ flags: MessageFlags.Ephemeral });
  // ⚠️ Ruling 10: a handler that throws after this point must still produce
  // a reply. Without this, the interaction is left showing "thinking…"
  // forever — the outer try/catch in discord.ts stops the bot crashing, but
  // it does nothing for the player already staring at a stuck interaction.
  let reply: Reply;
  try {
    reply = await spec.handler(ctx, inputFor(i));
  } catch (err) {
    console.error(`handler failed for /${pathOf(i.commandName, i.options.getSubcommand(false))}`, err);
    await i.editReply({ content: HANDLER_FAILED, embeds: [] });
    return;
  }
  await i.editReply({ content: reply.content, embeds: reply.embeds ?? [] });
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
  return false;
}

export { UNKNOWN };
