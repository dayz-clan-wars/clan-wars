/**
 * Shared test fakes for handler tests that need no database and no discord.js
 * client — just a `CommandGroup`'s specs called directly with a plain `Ctx`.
 *
 * ⚠️ Plain module, NOT a `.test.ts`. Importing a `.test.ts` from another test
 * file re-registers its `describe`s and runs them twice — see
 * `packages/roster/test/roster-exports.ts` for the same guard.
 */
import type { ClanView } from "@factions/roster";
import type { AutocompleteSource, CommandGroup, CommandInput, ComponentHandler, Ctx } from "../src/commands/types.js";

/** Finds one spec by its `path` (e.g. "me accept") off a given group. */
export function specOf(group: CommandGroup, path: string) {
  const found = group.specs.find((s) => s.path === path);
  if (!found) throw new Error(`no spec at path "${path}" in group "${group.command.name}"`);
  return found;
}

/**
 * Finds one autocomplete source by option name off the spec at `path`. Tests
 * call this instead of `specOf(...).autocomplete!.<option>(...)` — under
 * strict mode that reaches through an optional `Record`, which TypeScript
 * (correctly) treats as possibly `undefined`, forcing every call site to
 * scatter `!`. A missing source here throws a clear, named error instead of
 * either a silenced compiler or a bare "cannot invoke undefined" at runtime.
 */
export function sourceOf(group: CommandGroup, path: string, option: string): AutocompleteSource {
  const source = specOf(group, path).autocomplete?.[option];
  if (!source) throw new Error(`no autocomplete source "${option}" on spec "${path}" in group "${group.command.name}"`);
  return source;
}

/** Finds one component handler by its action name off a group. Same reasoning as `sourceOf`. */
export function componentOf(group: CommandGroup, action: string): ComponentHandler {
  const handler = group.components?.[action];
  if (!handler) throw new Error(`no component handler "${action}" in group "${group.command.name}"`);
  return handler;
}

/**
 * Builds a `CommandInput` from option overrides; unset options resolve to
 * null. The value type includes `undefined` so a test can write a union of
 * object literals with different keys present (e.g. one branch has
 * `gamertag`, another has `member`) without every literal needing every key
 * explicitly set to `null` — an absent key still reads back as `null` below.
 */
export function input(opts: Record<string, string | number | boolean | null | undefined> = {}): CommandInput {
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

/**
 * A complete `ClanView`, for `/clan` and (per a later task) `/guest`.
 * Shallow-merged with `over` — pass a partial `clan`/`me`/`leadership` object
 * built off `viewFixture().clan` etc. when only one field needs changing.
 */
export function viewFixture(over: Partial<ClanView> = {}): ClanView {
  return {
    clan: {
      id: 1, name: "Wolves", tag: "WLF", texture: "wolf", status: "active",
      createdAt: new Date("2026-01-01T00:00:00Z"), activatedAt: new Date("2026-01-01T00:00:00Z"), recruiting: false,
      playWindow: null, language: null, pitch: null, base: null,
    },
    me: { role: "leader", status: "full" },
    roster: [],
    invitesOut: [],
    requestsIn: [],
    rebindCandidates: [],
    leadership: { openClaim: null, openVote: null, canClaim: "not-eligible", nextVoteAllowedAt: null, leaderLastSeenAt: null },
    guestPasses: [],
    ...over,
  };
}
