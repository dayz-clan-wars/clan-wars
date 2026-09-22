/**
 * Discord's timestamp tokens. `<t:…:F>` is a full date and time, `<t:…:R>`
 * a live countdown; both render in each READER's timezone, which is the
 * whole reason a posted message stays correct without an edit.
 *
 * ⚠️ Every builder returns `null` for an unrepresentable instant rather
 * than throwing or substituting a fallback. Before this module the guard
 * existed in exactly one of six call sites (`feed-embed.ts`), whose comment
 * states the stake: a payload off an unvalidated jsonb column posts a
 * literal `<t:NaN:R>` into a public channel, permanently, because nothing
 * reposts. `null` puts the choice of degrade back where it belongs — the
 * caller already has one, and a shared helper must not overrule it.
 *
 * ⚠️ This file may be imported by the bot only. It is in @factions/copy
 * because the copy split (`lapsedCopy`, `link.ts`) has one foot on each
 * surface — but NOTHING reachable from the copy TABLES may emit a token,
 * or the website renders it as literal angle-bracket noise. That is held
 * by test/no-discord-tokens.test.ts.
 */

/** Whole seconds since the epoch, floored, or null if the date is invalid. */
function epoch(d: Date): number | null {
  const ms = d.getTime();
  if (!Number.isFinite(ms)) return null;
  // ⚠️ Math.floor, not Math.round: rounding 14:30:00.999 up to :01 makes a
  // deadline render one second later than the instant it actually is.
  // Flooring is also what every hand-rolled call site this replaces did.
  return Math.floor(ms / 1000);
}

/** `<t:…:F>` — a full date and time. For a deadline whose date matters. */
export function at(d: Date): string | null {
  const s = epoch(d);
  return s === null ? null : `<t:${s}:F>`;
}

/** `<t:…:R>` — a live countdown. For an instant whose distance matters. */
export function rel(d: Date): string | null {
  const s = epoch(d);
  return s === null ? null : `<t:${s}:R>`;
}

/** `<t:…:F> (<t:…:R>)` — the date to plan around and the countdown to feel. */
export function atRel(d: Date): string | null {
  const s = epoch(d);
  return s === null ? null : `<t:${s}:F> (<t:${s}:R>)`;
}
