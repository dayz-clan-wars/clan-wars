import { MIN_BASE_SPACING_M, RELEASED_POLE_GRACE_MS, SOLO_LAPSE_MS, WATCH_ZONE_RADIUS_M } from "@factions/domain";
import type { DeclareSoloReason } from "@factions/roster";
import { days, when } from "./format";

export { days };

/** What /base says for each `declareSolo` refusal. The guide's wording (ch. 4) for the 200 m rule. */
export const DECLARE_COPY: Record<DeclareSoloReason, string> = {
  "not-linked": "Link your character first.",
  "in-clan": "You are in a clan, so your base is the clan's. Solo declarations are for players outside one.",
  "no-raise": "The server log has not seen you raise a flag at that pole. Raise it, wait for the log to catch up, and try again.",
  "too-close": `Too close to another declared base. No two declared bases sit within ${MIN_BASE_SPACING_M} m of each other — first declared wins. The map cannot show you private bases, so this refusal is your first warning that one is nearby.`,
  "pole-taken": "That pole is already declared by someone else.",
  "owner-has-base": "You already have a declared base. Release it before declaring another.",
};

/** The banner /base shows when a solo declaration has lapsed but is still inside its grace. */
export const lapsedCopy = (at: Date) =>
  `Your declaration lapsed ${when(at)} — no raise in ${days(SOLO_LAPSE_MS)}. Raise your flag at the pole and declare it again below before it goes public.`;

/** Every code the two route handlers can redirect with. */
export const RESULT_COPY: Record<string, string> = {
  declared: `Declared. Your ${WATCH_ZONE_RADIUS_M} m watch zone is live. Keep raising your flag there — a solo base lapses after ${days(SOLO_LAPSE_MS)} without your raise.`,
  released: `Released. The pole stays private for ${days(RELEASED_POLE_GRACE_MS)}, then becomes public if nobody declares it.`,
  nothing: "You had no declared base to release.",
  unconfirmed: "Tick the box to confirm before releasing.",
  ...DECLARE_COPY,
};
