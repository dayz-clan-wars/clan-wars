import { FAILED_VOTE_COOLDOWN_MS, LEADER_SILENT_MS, SUCCESSION_WINDOW_MS } from "@factions/domain";
import type { ActorRefusal, ClaimOutcome, OpenVoteOutcome, CastOutcome } from "@factions/roster";
import { REFUSAL } from "./clan-copy";
import { days, hours } from "./format";

/**
 * Succession and no-confidence copy (spec §5/§7), built the same way
 * `clan-copy.ts` builds `RESULT_COPY` — one `Record<Outcome, string>` table
 * per action, `REFUSAL` spread in, flattened to `<action>.<outcome>` keys.
 * `"not-member"` is unreachable in practice (the actor is re-derived as a
 * full member before any of these outcomes can fire) but the type is still
 * exhaustive, so it gets the same wording as `not-in-clan`.
 */
/**
 * `not-eligible`/`leader-active` are also read directly by `/clan` to explain
 * why the claim button is hidden (`canClaim`, a `SuccessionEligibility`, not
 * a write outcome) — exported so the page and this table share one wording
 * rather than the page re-typing it inline.
 */
export const CLAIM_REFUSAL: Record<"not-eligible" | "leader-active", string> = {
  "not-eligible": "Only an officer can claim while the clan has officers.",
  "leader-active": `The leader has been seen in game within the last ${days(LEADER_SILENT_MS)}.`,
};
const CLAIM: Record<ClaimOutcome | ActorRefusal | "unconfirmed", string> = {
  ...REFUSAL,
  ...CLAIM_REFUSAL,
  "not-member": REFUSAL["not-in-clan"],
  ok: `Claimed. The leader has ${hours(SUCCESSION_WINDOW_MS)} to be seen in game; if they are, the claim is void. The clan channel has been told.`,
  "claim-open": "A claim is already open.",
  "is-leader": "You are the leader.",
  unconfirmed: "Tick the box to confirm before claiming leadership.",
};
const OPEN_VOTE: Record<OpenVoteOutcome | ActorRefusal | "unconfirmed", string> = {
  ...REFUSAL,
  "not-member": REFUSAL["not-in-clan"],
  ok: "Vote opened. The clan channel has been told.",
  // Generic on purpose: a result code is looked up (never echoed), so this
  // string can't carry the actual nominee's name — see lib/copy-lookup.ts.
  passed: "Passed on the spot — the electorate was small enough. The nominee leads.",
  cooldown: `A vote failed recently; the next is possible after ${days(FAILED_VOTE_COOLDOWN_MS)} from then.`,
  "vote-open": "A no-confidence vote is already open.",
  "nominee-is-leader": "The leader cannot be nominated against themselves.",
  "nominee-not-member": "That player is not a full member of your clan.",
  "is-leader": "The leader hands over leadership in settings instead of voting.",
  unconfirmed: "Tick the box to confirm before opening a vote.",
};
const CAST: Record<CastOutcome | ActorRefusal | "unconfirmed", string> = {
  ...REFUSAL,
  ok: "Vote cast.",
  passed: "Vote cast — and that was the last one needed. The vote has passed.",
  "already-voted": "You already voted in this vote.",
  "not-in-electorate": "You are not in this vote's electorate — it was fixed when the vote opened, without the leader.",
  "no-vote": "There is no open vote.",
  unconfirmed: "Tick the box to confirm before voting.",
};

const TABLES = { "claim-succession": CLAIM, "open-vote": OPEN_VOTE, "cast-vote": CAST } as const;
export type LeadershipAction = keyof typeof TABLES;
export function leadershipCode<A extends LeadershipAction>(action: A, outcome: keyof (typeof TABLES)[A] & string): string {
  return `${action}.${outcome}`;
}

/** Every code a leadership route can redirect with, flattened to "<action>.<outcome>". A null-prototype object, same reasoning as `RESULT_COPY`. */
export const LEADERSHIP_RESULT_COPY: Record<string, string> = Object.assign(Object.create(null), Object.fromEntries(
  Object.entries(TABLES).flatMap(([action, table]) => Object.entries(table).map(([outcome, text]) => [`${action}.${outcome}`, text])),
));
