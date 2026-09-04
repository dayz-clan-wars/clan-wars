import type { Character, Step } from "./types";

/**
 * Demo data for the character-link flow at /link.
 *
 * ⚠️ Every value here is INVENTED. Nothing came from the game server, no
 * Discord account was consulted, and nothing in this route may ever read the
 * real thing — the site is a surface, never a source of truth, and
 * `apps/web/test/smoke.test.ts` is what holds that line now that the live
 * database sits one loopback port away.
 *
 * Ported from the `Clan Wars Gamertag Link.dc.html` design canvas.
 */

/**
 * The characters the event log has seen for this account.
 *
 * ⚠️ The design's own list showed three and then named the "someone else is
 * verifying" refusal against SubZeroKilo — which its list had already spent on
 * "already linked". A fourth character is added here so BOTH refusals stay
 * reachable in the built flow; the design's three are otherwise unchanged.
 */
export const CHARACTERS: readonly Character[] = [
  { gamertag: "SubatomicRacer", seen: "Seen 4m ago" },
  { gamertag: "SubatomicSeven", seen: "Seen 2d ago" },
  { gamertag: "SubZeroKilo", seen: "Seen 6d ago", blocked: "linked" },
  { gamertag: "SubduedMagpie", seen: "Seen 1d ago", blocked: "verifying", contestedFor: "6 hours" },
];

/** The character the pending and verified states are shown against. */
export const SUBJECT = "SubatomicRacer";

/** The date the verified card reports. Matches the mobile shell's Me screen. */
export const LINKED_ON = "12 Aug 2026";

/**
 * The drawn sequence. Three emotes, performed in this order.
 *
 * ⚠️ Order is the entire proof, so these are an ordered list in the markup too
 * — not a styled stack of divs. A screen reader that cannot tell the player
 * this is the second of three has lost the only thing that makes it a
 * challenge rather than a shopping list.
 */
export const SEQUENCE: readonly Step[] = [
  { emote: "Salute", ordinal: "First" },
  { emote: "Sit down", ordinal: "Second" },
  { emote: "Clap", ordinal: "Third" },
];

/** Draws per character per day. The cap is a security bound, so the UI says it. */
export const MAX_DRAWS_PER_DAY = 3;

/** Draws already spent on SUBJECT today — the design's card says "2 draws left". */
export const DRAWS_USED = 1;

/** Time left on the pending challenge, at each confirmed count the design drew. */
export const EXPIRY_AT_ZERO = "23h 41m";
export const EXPIRY_AT_TWO = "21h 08m";
