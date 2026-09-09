import { BOARD_KINDS, type BoardKind } from "@factions/roster";

/** Rows on a board panel. The rest are on the board's own page. */
export const BOARD_TOP = 10;

/**
 * The URL segment of each board's full page (`/players/boards/{slug}`,
 * `/clan/board/{slug}`). Kebab-case, so the address reads as words.
 */
export const BOARD_SLUGS: Record<BoardKind, string> = {
  raiders: "raiders",
  killers: "killers",
  deaths: "deaths",
  kd: "kd",
  playTime: "play-time",
  friendlyFire: "friendly-fire",
  builders: "builders",
  streaks: "streaks",
  longestKills: "longest-kills",
};

/** The board a URL segment names, or null. The raw segment is looked up, never echoed. */
export function boardKindFromSlug(raw: string): BoardKind | null {
  return BOARD_KINDS.find((k) => BOARD_SLUGS[k] === raw) ?? null;
}

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
