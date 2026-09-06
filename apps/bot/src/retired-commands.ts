import type { Reply } from "./commands.js";

/**
 * Spec §9.1: every slash command is retired in one step and, until removed
 * from the application, answers ephemerally with one line and a link. The
 * names stay registered — bare, no options — so a client with a stale
 * command list gets this pointer and not Discord's "unknown command".
 */
export const RETIRED_COMMANDS = ["link", "unlink", "whoami", "faction"] as const;
export const RETIRED_DESCRIPTION = "Retired — manage this on the site.";

/** Where the thing this command used to do lives now. */
export function retiredPath(commandName: string, subcommand: string | null): string {
  if (commandName === "link") return "/link";
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
