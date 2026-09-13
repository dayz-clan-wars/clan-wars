import { SlashCommandBuilder, type RESTPostAPIApplicationCommandsJSONBody } from "discord.js";
import { RETIRED_COMMANDS, RETIRED_DESCRIPTION } from "../retired-commands.js";
import { baseGroup } from "./base.js";
import { linkGroup } from "./link.js";
import type { CommandGroup, CommandSpec } from "./types.js";

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
export const GROUPS: CommandGroup[] = [linkGroup, baseGroup];

export const SPECS: Map<string, CommandSpec> = new Map(
  GROUPS.flatMap((g) => g.specs).map((s) => [s.path, s]),
);

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
