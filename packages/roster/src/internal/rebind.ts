import { RELEASED_POLE_GRACE_MS } from "@factions/domain";

/**
 * How long a pole stays private after its faction moves out of it. There is
 * no cooldown between moves; what stops a clan bouncing between two poles to
 * keep both private is the no-moving-back rule in `declareTx` (a pole you
 * released cannot be yours again until this grace has run out).
 */
export const RELEASE_GRACE_MS = RELEASED_POLE_GRACE_MS;

/** A `flag.raised` by a full member (any flag) that could name a new pole. */
export type QualifyingRaise = {
  poleKey: string;
  x: number;
  y: number;
  z: number;
  dayzId: string;
  gamertag: string;
  occurredAt: Date;
  /** The event row itself — declareTx's evidence for the pole this names. */
  eventId: number;
};

/**
 * The poles a leader may currently choose between, newest first.
 *
 * Pure so every boundary is testable without a database, and so the store
 * fetches while this decides — the same split as `decide()` in dormancy.ts.
 *
 * The lookback window is the caller's to set — the site passes
 * `REBIND_CONFIRM_MS`.
 */
export function selectCandidates(
  raises: QualifyingRaise[],
  // currentPoleKey is nullable: `RebindTarget.poleKey` comes from a left
  // join onto `declarations` now, though an active/dormant faction always
  // has one in practice.
  opts: { currentPoleKey: string | null; now: Date; windowMs: number },
): QualifyingRaise[] {
  const cutoff = opts.now.getTime() - opts.windowMs;

  const fresh = raises.filter((r) =>
    // >= so a raise exactly at the window edge still counts; the boundary
    // belongs to the player, who cannot see our clock.
    r.occurredAt.getTime() >= cutoff
    // ⚠️ The faction's current pole is never a candidate: rebinding onto it
    // would release it and start its grace for nothing.
    && r.poleKey !== opts.currentPoleKey);

  // Newest first, with a deterministic tiebreak: ADM timestamps have
  // second granularity, so two raises at one pole in the same second are
  // ordinary and an unstable order would make the leader's menu flap.
  const sorted = [...fresh].sort((a, b) =>
    b.occurredAt.getTime() - a.occurredAt.getTime() || a.poleKey.localeCompare(b.poleKey));

  // One entry per pole. A member raising twice at the same pole is one choice,
  // not two identical ones.
  const seen = new Set<string>();
  return sorted.filter((r) => (seen.has(r.poleKey) ? false : (seen.add(r.poleKey), true)));
}
