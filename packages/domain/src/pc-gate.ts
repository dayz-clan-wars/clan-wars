/**
 * Whether an account should be banned for playing on PC without linking.
 *
 * This server is for Xbox. A PC player is welcome if we know who they are;
 * the ban is what makes linking non-optional for them.
 *
 * ⚠️ Level-triggered. Every pass recomputes what should be true from the five
 * facts, exactly like the truck wipe and the raid window, so a ban that was
 * never written, or a lift lost on its way to the database, is repaired on the
 * next tick rather than leaving someone banned forever with nothing to show
 * why.
 */
export type PcGateFacts = {
  /** ⚠️ EVER seen on desktop, not "last seen on". One console session must not clear it. */
  seenOnDesktop: boolean;
  linked: boolean;
  /** A verification challenge that is live right now: not completed, not canceled, not expired. */
  challengeOpen: boolean;
  /** A ban with reason `unlinked_pc` that is pending, applied, or already being lifted. */
  activeBan: boolean;
  /** ⚠️ This account has had its one lift, ever. See the design doc §4. */
  liftSpent: boolean;
};

export type PcGateAction = "none" | "ban" | "lift";

export function pcGateAction(f: PcGateFacts): PcGateAction {
  // Not a PC player, or a known one: nothing here applies.
  if (!f.seenOnDesktop || f.linked) return "none";

  if (f.activeBan) {
    // ⚠️ Starting a link opens the door ONCE, and only for a ban that is
    // already in force. `liftSpent` is what stops "link, get unbanned, never
    // finish, repeat" from being an infinite supply of play time.
    return f.challengeOpen && !f.liftSpent ? "lift" : "none";
  }

  // ⚠️ An open challenge does NOT exempt an unbanned player. Being mid-link
  // is honoured by the once-only LIFT above, never by a standing exemption:
  // an exemption renews every time the player re-rolls their challenge (24 h
  // TTL, and the draw cap permits a re-roll a day), so it would never lapse,
  // no ban would ever be written, no lift would ever be spent, and the whole
  // gate would silently do nothing. Ban first; the lift is what honours the
  // attempt, on a later pass once the ban is applied.
  return "ban";
}
