import type { Reply } from "./commands.js";

/**
 * Spec §9.1: every slash command is retired in one step and, until removed
 * from the application, answers ephemerally with one line and a link. The
 * names stay registered — bare, no options — so a client with a stale
 * command list gets this pointer and not Discord's "unknown command".
 *
 * ⚠️ "link" left this list in Task 4 of the Discord-commands plan: `/link`
 * is now a real command (`linkGroup` in `commands/index.ts`), and
 * `buildCommands()` would emit the name twice — which Discord's PUT
 * rejects — if it stayed here too. `whoami` and `faction` stay retired
 * until later tasks give Discord their real replacements; `unlink` is
 * different — `/link unlink` already IS its real replacement — but the
 * bare `unlink` name stays registered here too, stub and all, because the
 * two are separate Discord commands and dropping the bare one now would
 * hand a client with a stale command list "unknown command" instead of this
 * stub's pointer. It is removed, not repointed, once stale caches age out.
 */
export const RETIRED_COMMANDS = ["unlink", "whoami", "faction"] as const;
export const RETIRED_DESCRIPTION = "Retired — manage this on the site.";

/** Where the thing this command used to do lives now. */
export function retiredPath(commandName: string, subcommand: string | null): string {
  if (commandName === "unlink" || commandName === "whoami") return "/me";
  switch (subcommand) {
    case "claim": case "invites": return "/me";
    case "info": case "roster": return "/clans";
    case "rename": case "transfer": case "disband": case "rebind": return "/clan/settings";
    default: return "/clan";
  }
}

export function retiredReply(siteBaseUrl: string, commandName: string, subcommand: string | null): Reply {
  return { content: `Manage this on the site: ${siteBaseUrl}${retiredPath(commandName, subcommand)}`, ephemeral: true };
}
