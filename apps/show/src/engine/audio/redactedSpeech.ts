// Spoken forms for the aliases the screening/redaction stage substitutes for a name it will
// not speak or draw plainly (spec §7.3). A redacted alias must never reach the pronunciation
// model and never be written to `show_pronunciations` — callers filter these out before either,
// using `isRedactedAlias`, and route them through `redactedSpokenForms` instead.

export const REDACTED_PLAYER_RE = /^REDACTED_PLAYER_(\d+)$/;
export const REDACTED_CLAN_RE = /^REDACTED_CLAN_(\d+)$/;

/** True for any alias matching the redacted player or clan shape exactly. */
export function isRedactedAlias(s: string): boolean {
  return REDACTED_PLAYER_RE.test(s) || REDACTED_CLAN_RE.test(s);
}

/**
 * Map each redacted alias to the line it should be spoken as. A redacted clan is always
 * "a clan we can't name on this network". A redacted player is "the player whose name we
 * cannot say" when it is the only distinct redacted player alias present, or "player number
 * N whose name we cannot say" (N from the alias itself) once two or more distinct player
 * aliases appear — duplicates of the same alias in the input do not count as a second player.
 */
export function redactedSpokenForms(aliases: string[]): Record<string, string> {
  const distinctPlayers = new Set(aliases.filter((a) => REDACTED_PLAYER_RE.test(a)));
  const several = distinctPlayers.size >= 2;
  const out: Record<string, string> = {};
  for (const alias of new Set(aliases)) {
    const playerMatch = alias.match(REDACTED_PLAYER_RE);
    if (playerMatch) {
      out[alias] = several
        ? `player number ${playerMatch[1]} whose name we cannot say`
        : "the player whose name we cannot say";
      continue;
    }
    if (REDACTED_CLAN_RE.test(alias)) {
      out[alias] = "a clan we can't name on this network";
    }
  }
  return out;
}
