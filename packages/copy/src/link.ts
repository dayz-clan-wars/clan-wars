import type { IssueOutcome, IssueOutcomeKind, LinkStatus } from "@factions/roster";
import { LINK_EMOTES } from "@factions/domain";

/** What /link says for each refusal. "issued" and "live" render the challenge card instead of a line. */
export const ISSUE_COPY: Record<IssueOutcomeKind, (o: IssueOutcome, endsWhen?: string) => string> = {
  "already-linked": (o) => `You are already linked to ${name(o)}. Unlink on your page first if you need to bind a different character.`,
  "just-linked": (o) => `You just finished linking to ${name(o)}. Unlink on your page first if you need to bind a different character.`,
  "unknown-character": () => "The server has not seen that character. Pick one from the list — only characters the event log has seen can be linked.",
  "taken": (o) => `${name(o)} is already linked to another Discord account. If that character is yours, ask an admin.`,
  "live": (o) => `You already have a challenge open for ${name(o)}.`,
  "too-many-draws": (o) => `You have asked for too many sequences for ${name(o)} today. Try again tomorrow — or, if there is an emote you cannot find on the wheel, say so in the Discord rather than working around it.`,
  "issued": (o) => `Challenge issued for ${name(o)}.`,
  // ⚠️ Second argument is the FORMATTED instant — same reason as lapsedCopy
  // in base.ts. The bot passes rel(), the site passes its own formatter.
  "held-by-other": (o, endsWhen = "") => `Someone else is verifying ${name(o)} right now, so a challenge cannot be issued for that character yet. Their attempt ends ${endsWhen}. If that character is yours, ask an admin.`,
  "unavailable": () => "Could not issue a challenge right now. Try again in a moment.",
};

/**
 * What /link says about how the last challenge ended, from `LinkStatus.ended`.
 *
 * Keyed to `Exclude<LinkStatus["ended"], null>`, not `as const`: that closed
 * union is the real set of non-null reasons `linkStatusDb` can report, so a
 * new one fails the build here instead of falling through a defensive
 * `Object.hasOwn` guard at the embed and rendering nothing.
 */
export const ENDED_COPY: Record<Exclude<LinkStatus["ended"], null>, string> = {
  "expired": `Your last challenge expired before the ${LINK_EMOTES} emotes were seen. Draw a new one when you are in game and ready.`,
  "budget-exhausted": `Your last challenge was canceled: too many emotes were performed before the sequence was completed. Draw a new one and perform just those ${LINK_EMOTES} emotes, in order. If one of them is not on your emote wheel, say so in the Discord — it may be an emote no one can perform.`,
  "already-linked": "Your last challenge was canceled: that character is already linked to another Discord account. If it is yours — you changed Discord accounts, say — ask an admin to move the link.",
};

/**
 * What the page /me forwards to says after an unlink attempt. Keyed to the
 * real `UnlinkOutcome` reasons (plus "ok") so a new one fails the build
 * instead of a `!`-asserted lookup silently rendering `undefined`.
 */
export const UNLINK_COPY: Record<"ok" | "in-clan" | "not-linked", string> = {
  ok: "Unlinked. Your solo base, if you had one, has been released.",
  "in-clan": "You are in a clan. Leave it before unlinking — a clan's leader is identified by this link.",
  "not-linked": "You were not linked to a character.",
};

/**
 * The website looks `UNLINK_COPY` up by an attacker-supplied `?unlink=` code
 * (see `apps/web/lib/copy-lookup.ts`), so it needs `Record<string, ...>`
 * ergonomics without widening the table itself back to one — this accessor
 * is the boundary, and `Object.hasOwn` keeps a `?unlink=__proto__` miss
 * rather than returning a prototype property.
 */
export function unlinkCopy(code: string): string | undefined {
  return Object.hasOwn(UNLINK_COPY, code) ? UNLINK_COPY[code as keyof typeof UNLINK_COPY] : undefined;
}

function name(o: IssueOutcome): string {
  return "gamertag" in o ? o.gamertag : "that character";
}

/**
 * "23 h 59 min" while an hour or more remains, "9:41" under an hour, "0:00"
 * once expired. The challenge lasts LINK_TTL_MS (24 h since 2026-09-08), so
 * the first day reads as hours and the last hour ticks by the second.
 */
export function formatRemaining(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s >= 3600) return `${Math.floor(s / 3600)} h ${Math.floor((s % 3600) / 60)} min`;
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}
