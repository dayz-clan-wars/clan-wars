import { REBIND_COOLDOWN_MS as RULE_REBIND_COOLDOWN_MS, RELEASED_POLE_GRACE_MS } from "@factions/domain";

/** 7 days, matching DayZ's own flag refresh cycle (`FlagRefreshMaxDuration`). */
export const REBIND_COOLDOWN_MS = RULE_REBIND_COOLDOWN_MS;

/**
 * How long a pole stays private after its faction moves out of it.
 *
 * ⚠️ MUST stay strictly shorter than REBIND_COOLDOWN_MS, and 3 days against 7
 * is the whole reason for the gap. At equal values a faction can alternate
 * between two poles and keep both permanently private — rebind away, let the
 * old pole's grace cover it until the cooldown expires, rebind back. At 3
 * against 7 each pole is publicly listed for four days of every cycle and the
 * alternation buys nothing.
 *
 * ⚠️ Nothing consumes this yet. It becomes live with base declaration
 * (docs/superpowers/specs/2026-09-03-base-declaration-design.md), which is what
 * gives "public" somewhere to mean. It is defined and pinned here NOW because
 * the relationship above is the thing worth protecting, and by the time there
 * is a consumer the two numbers will sit in different subsystems with nothing
 * relating them. See apps/bot/test/rebind.test.ts.
 */
export const RELEASE_GRACE_MS = RELEASED_POLE_GRACE_MS;

/** A `flag.raised` of the faction's own texture that could name a new pole. */
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
    // ⚠️ The faction's current pole is never a candidate. Rebinding onto it is
    // a no-op that would still burn the 7-day cooldown, so a leader could lock
    // themselves out by confirming their ordinary weekly raise at home.
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

/** Milliseconds left on the cooldown; 0 when a rebind is allowed now. */
export function cooldownRemainingMs(
  reboundAt: Date | null,
  now: Date,
  cooldownMs: number = REBIND_COOLDOWN_MS,
): number {
  if (reboundAt === null) return 0;
  const elapsed = now.getTime() - reboundAt.getTime();
  return elapsed >= cooldownMs ? 0 : cooldownMs - elapsed;
}
