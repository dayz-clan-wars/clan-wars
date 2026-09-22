import type { AwardView } from "@factions/roster";
import { nextRestartAt, type AwardState } from "@factions/domain";
import { kitSpotView, type KitChallengeView, type KitSpotView } from "./kit-view";

/**
 * Everything /awards/<id> renders, already in the shape it renders it.
 *
 * ⚠️ Built on the server for the first paint AND every poll, for kitView's
 * reasons: the grid ref needs the world's geometry, raw metres must never
 * reach the browser, and every Date is a string so the first render and the
 * first poll agree.
 */
export type AwardPageView = {
  id: number; label: string; reason: string; state: AwardState;
  placeBy: string; liveFrom: string | null; expiresAt: string | null;
  /** When a placed-but-waiting award will first appear. */
  nextRestartAt: string;
  gamertag: string | null;
  picks: Record<string, string>;
  spot: KitSpotView | null;
  challenge: KitChallengeView | null;
};

export function awardPageView(v: AwardView, now: Date): AwardPageView {
  return {
    id: v.id, label: v.label, reason: v.reason, state: v.state,
    placeBy: v.placeBy.toISOString(),
    liveFrom: v.liveFrom?.toISOString() ?? null,
    expiresAt: v.expiresAt?.toISOString() ?? null,
    nextRestartAt: nextRestartAt(now).toISOString(),
    gamertag: v.linked?.gamertag ?? null,
    picks: v.picks,
    spot: v.spot ? kitSpotView(v.spot) : null,
    challenge: v.challenge
      ? { id: v.challenge.id, steps: v.challenge.steps, confirmed: v.challenge.confirmed, expiresAt: v.challenge.expiresAt.toISOString() }
      : null,
  };
}
