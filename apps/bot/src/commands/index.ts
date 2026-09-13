import { SlashCommandBuilder, type RESTPostAPIApplicationCommandsJSONBody } from "discord.js";
import { RETIRED_COMMANDS, RETIRED_DESCRIPTION } from "../retired-commands.js";
import { baseGroup } from "./base.js";
import { clanGroup } from "./clan.js";
import { clansGroup } from "./clans.js";
import { linkGroup } from "./link.js";
import { meGroup } from "./me.js";
import { rosterGroup } from "./roster.js";
import type { CommandGroup, CommandSpec, ComponentHandler, ModalHandler } from "./types.js";

/**
 * The registry. A group states its Discord JSON and its handlers in one
 * place, and `command-registration.test.ts` asserts the two halves are a
 * bijection — so a command cannot be registered with nothing behind it, and a
 * handler cannot rot unreachable.
 *
 * ⚠️ The retired stubs stay registered until Discord can do everything they
 * point at (spec §1, corrected in plan 1). They are removed in the last task
 * of plan 3, not before: a player who loses the stub before the real command
 * lands gets Discord's "unknown command" and no pointer at all.
 */
export const GROUPS: CommandGroup[] = [linkGroup, baseGroup, meGroup, rosterGroup, clanGroup, clansGroup];

export const SPECS: Map<string, CommandSpec> = new Map(
  GROUPS.flatMap((g) => g.specs).map((s) => [s.path, s]),
);

/**
 * The router's own registries, one per interaction kind it handles beyond
 * chat input — see `route.ts`. Kept mutable (`Map`/`Set`, not a frozen
 * object) so a test can register a throwaway action for the duration of one
 * case, the same way `SPECS` already allows for chat-input handlers.
 */
export const COMPONENTS: Map<string, ComponentHandler> = new Map(
  GROUPS.flatMap((g) => Object.entries(g.components ?? {})),
);
export const MODALS: Map<string, ModalHandler> = new Map(
  GROUPS.flatMap((g) => Object.entries(g.modals ?? {})),
);
export const MODAL_OPENERS: Set<string> = new Set(GROUPS.flatMap((g) => g.modalOpeners ?? []));

export function buildCommands(): RESTPostAPIApplicationCommandsJSONBody[] {
  return [
    ...RETIRED_COMMANDS.map((name) =>
      new SlashCommandBuilder().setName(name).setDescription(RETIRED_DESCRIPTION).toJSON()),
    new SlashCommandBuilder()
      .setName("guest")
      .setDescription("Give someone a 24h voice guest pass")
      .addUserOption((o) => o.setName("user").setDescription("Who").setRequired(true))
      .toJSON(),
    ...GROUPS.map((g) => g.command.toJSON()),
  ];
}
