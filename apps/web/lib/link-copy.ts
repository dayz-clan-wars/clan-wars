export { ISSUE_COPY, ENDED_COPY, UNLINK_COPY, unlinkCopy, formatRemaining } from "@factions/copy";

/** Said only after a search for exactly the typed text agrees (lib/link-claim.ts resolveTyped). */
export const LINK_UNSEEN = "The server has not seen that character. Pick one from the list — only characters the event log has seen can be linked.";
/** A request that did not go through at all. Never a verdict on the character: nothing was decided. */
export const LINK_FAILED = "That did not go through, so nothing changed. Check your connection and try again.";
