/**
 * The character-link state machine, from the design's handoff notes:
 *
 *   signedOut → unlinked → pending → verified,  with expired a branch of pending.
 *
 * ⚠️ `loading` is a real member, not a convenience. The design is explicit that
 * it renders NOTHING rather than a state that is about to be wrong: a card that
 * flashes "Link your character" at an already-linked player, for the one frame
 * before the session resolves, tells them their link is gone.
 */
export type LinkState =
  | "loading"
  | "signedOut"
  | "unlinked"
  | "pending"
  | "expired"
  | "verified";

/**
 * Why a character cannot be claimed right now.
 *
 * ⚠️ `verifying` is deliberately distinct from `linked`. "Already linked" is
 * permanent and sends the player to an admin; "someone else is verifying" ends
 * at a known time, and the design refuses to collapse the two into "try again
 * in a moment" — that would be a lie for up to a full day.
 */
export type Blocker = "linked" | "verifying";

export type Character = {
  gamertag: string;
  /** Age of the last sighting in the event log, already humanised. */
  seen: string;
  blocked?: Blocker;
  /** When the other account's attempt lapses. Only meaningful for `verifying`. */
  contestedFor?: string;
};

/** One emote of the three, and whether the SERVER has confirmed it. */
export type Step = {
  /** The emote as it is labelled on the in-game wheel. */
  emote: string;
  /** "First" / "Second" / "Third" — the order is the whole proof. */
  ordinal: string;
};

export const ORDINALS = ["First", "Second", "Third"] as const;
