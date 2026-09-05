import type { IssueOutcome, IssueOutcomeKind } from "@factions/roster";
import { LINK_EMOTES } from "@factions/domain";

/** What /link says for each refusal. "issued" and "live" render the challenge card instead of a line. */
export const ISSUE_COPY: Record<IssueOutcomeKind, (o: IssueOutcome) => string> = {
  "already-linked": (o) => `You are already linked to ${name(o)}. Unlink on your page first if you need to bind a different character.`,
  "just-linked": (o) => `You just finished linking to ${name(o)}. Unlink on your page first if you need to bind a different character.`,
  "unknown-character": () => "The server has not seen that character. Pick one from the list — only characters the event log has seen can be linked.",
  "taken": (o) => `${name(o)} is already linked to another Discord account. If that character is yours, ask an admin.`,
  "live": (o) => `You already have a challenge open for ${name(o)}.`,
  "too-many-draws": (o) => `You have asked for too many sequences for ${name(o)} today. Try again tomorrow — or, if there is an emote you cannot find on the wheel, say so in the Discord rather than working around it.`,
  "issued": (o) => `Challenge issued for ${name(o)}.`,
  "held-by-other": (o) => `Someone else is verifying ${name(o)} right now, so a challenge cannot be issued for that character yet. Their attempt ends ${o.kind === "held-by-other" ? at(o.expiresAt) : ""}. If that character is yours, ask an admin.`,
  "unavailable": () => "Could not issue a challenge right now. Try again in a moment.",
};

/** What /link says about how the last challenge ended, from `LinkStatus.ended`. */
export const ENDED_COPY = {
  "expired": `Your last challenge expired before the ${LINK_EMOTES} emotes were seen. Draw a new one when you are in game and ready.`,
  "budget-exhausted": `Your last challenge was canceled: too many emotes were performed before the sequence was completed. Draw a new one and perform just those ${LINK_EMOTES} emotes, in order. If one of them is not on your emote wheel, say so in the Discord — it may be an emote no one can perform.`,
  "already-linked": "Your last challenge was canceled: that character is already linked to another Discord account. If it is yours — you changed Discord accounts, say — ask an admin to move the link.",
} as const;

/** What /me says after an unlink attempt, keyed by the ?unlink= code. Never echoes the raw value. */
export const UNLINK_COPY: Record<string, string> = {
  ok: "Unlinked. Your solo base, if you had one, has been released.",
  "in-clan": "You are in a clan. Leave it before unlinking — a clan's leader is identified by this link.",
  "not-linked": "You were not linked to a character.",
};

function name(o: IssueOutcome): string {
  return "gamertag" in o ? o.gamertag : "that character";
}
function at(d: Date | string): string {
  return new Date(d).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", timeZone: "UTC" }) + " UTC";
}

/** "9:41" from a millisecond remainder; "0:00" once expired. */
export function formatRemaining(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}
