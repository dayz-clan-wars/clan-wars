import type { RESTPostAPIApplicationCommandsJSONBody } from "discord.js";
import { airdropGroup } from "./airdrop.js";
import { awardGroup } from "./award.js";
import { baseGroup } from "./base.js";
import { bountyGroup } from "./bounty.js";
import { clanGroup } from "./clan.js";
import { clansGroup } from "./clans.js";
import { foundGroup } from "./found.js";
import { guestGroup } from "./guest.js";
import { leadGroup } from "./lead.js";
import { linkGroup } from "./link.js";
import { mapGroup } from "./map.js";
import { meGroup } from "./me.js";
import { rosterGroup } from "./roster.js";
import { alphasGroup, scoreboardGroup, seasonsGroup, warlogGroup } from "./scoring.js";
import { achievementsGroup, boardGroup, playerGroup } from "./stats.js";
import { vaultGroup } from "./vault.js";
import type { CommandGroup, CommandSpec, ComponentHandler, ModalHandler } from "./types.js";

/**
 * The registry. A group states its Discord JSON and its handlers in one
 * place, and `command-registration.test.ts` asserts the two halves are a
 * bijection — so a command cannot be registered with nothing behind it, and a
 * handler cannot rot unreachable.
 */
export const GROUPS: CommandGroup[] = [linkGroup, baseGroup, meGroup, rosterGroup, clanGroup, clansGroup, leadGroup, foundGroup, guestGroup, vaultGroup, mapGroup, scoreboardGroup, alphasGroup, seasonsGroup, warlogGroup, playerGroup, boardGroup, achievementsGroup, airdropGroup, awardGroup, bountyGroup];

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
export const UPDATERS: Set<string> = new Set(GROUPS.flatMap((g) => g.updatesInPlace ?? []));

export function buildCommands(): RESTPostAPIApplicationCommandsJSONBody[] {
  return GROUPS.map((g) => g.command.toJSON());
}
