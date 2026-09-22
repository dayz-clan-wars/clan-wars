import type { AwardState } from "@factions/domain";

/**
 * The award pages' copy. Voice as the kit page's: plain sentences, no em
 * dashes, and nothing that frames the spot as protected. It respawns every
 * restart, and anyone who finds it can take it.
 */
export const STATE_COPY: Record<AwardState, { title: string; line: string }> = {
  unplaced: { title: "Not placed yet", line: "Pick each piece, then mark the spot in game." },
  waiting: { title: "Placed", line: "It spawns at the next restart, then every restart after until it runs out." },
  live: { title: "Live", line: "It respawns at your spot every restart." },
  lapsed: { title: "Not placed in time", line: "This award had to be placed within a week of winning it." },
  expired: { title: "Ended", line: "This award has run its course." },
  revoked: { title: "Taken back", line: "An admin revoked this award." },
};

/** Why a write was refused, by the `reason` the API sends. `failed` is anything that is not a refusal. */
export const RESULT_COPY: Record<string, string> = {
  "not-found": "That award is not yours, or it does not exist.",
  ended: "This award has ended, so it can no longer be changed.",
  "bad-slot": "That is not one of this award's pieces.",
  "bad-pick": "That item is not on the list for this piece.",
  incomplete: "Pick every piece before you mark the spot.",
  "not-linked": "Link your character first. The spot is marked in game.",
  failed: "That did not save. Try again in a moment.",
};

export const GROUND_RULES = [
  "It respawns at your spot every restart until it runs out.",
  "Anyone who finds it can take it. What you pick up is yours to keep.",
  "You can move it or change a piece any time before it ends. Changes land at the next restart.",
];
