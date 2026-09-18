/**
 * ⚠️ Re-exported, not defined here: `BOARD_TOP`, `BOARD_SLUGS` and
 * `boardKindFromSlug` moved to `@factions/copy` (2026-09-18) once the bot's
 * leaderboard channel needed the identical row count and the identical board
 * links. Site imports are unchanged by design — keep importing them from here.
 */
export { BOARD_TOP, BOARD_SLUGS, boardKindFromSlug } from "@factions/copy";

/**
 * `?page=` is attacker-supplied. A positive integer is that page; anything
 * else — absent, repeated, zero, negative, fractional, garbage — is page 1.
 */
export function parsePageParam(raw: string | string[] | undefined): number {
  if (typeof raw !== "string" || !/^[1-9]\d{0,5}$/u.test(raw)) return 1;
  return Number(raw);
}

/** `?season=all` or `?season=N` for a resolved scope, so a link keeps the scope the viewer chose. */
export function seasonQuery(scope: { kind: "all" } | { kind: "season"; number: number }): string {
  return scope.kind === "all" ? "season=all" : `season=${scope.number}`;
}
