/**
 * Shared test fakes for handler tests that need no database and no discord.js
 * client — just a `CommandGroup`'s specs called directly with a plain `Ctx`.
 *
 * ⚠️ Plain module, NOT a `.test.ts`. Importing a `.test.ts` from another test
 * file re-registers its `describe`s and runs them twice — see
 * `packages/roster/test/roster-exports.ts` for the same guard.
 */
import type { CommandGroup, CommandInput, Ctx } from "../src/commands/types.js";

/** Finds one spec by its `path` (e.g. "me accept") off a given group. */
export function specOf(group: CommandGroup, path: string) {
  const found = group.specs.find((s) => s.path === path);
  if (!found) throw new Error(`no spec at path "${path}" in group "${group.command.name}"`);
  return found;
}

/** Builds a `CommandInput` from option overrides; unset options resolve to null. */
export function input(opts: Record<string, string | number | boolean | null> = {}): CommandInput {
  return {
    actorDiscordId: "111",
    string: (n: string) => (opts[n] as string) ?? null,
    integer: (n: string) => (opts[n] as number) ?? null,
    boolean: (n: string) => (opts[n] as boolean) ?? null,
    user: (n: string) => (opts[n] as string) ?? null,
  };
}

/** Builds a `Ctx` from a partial roster stub of plain async functions. */
export function ctxWith(roster: Record<string, unknown>): Ctx {
  return { roster, now: new Date("2026-09-13T00:00:00Z"), siteBaseUrl: "https://x" } as unknown as Ctx;
}
