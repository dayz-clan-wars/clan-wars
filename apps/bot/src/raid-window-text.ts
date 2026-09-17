import type { RaidWindowState } from "@factions/domain";

/** Discord's <t:…:F> renders in each reader's own timezone — never hard-code one. */
function stamp(d: Date): string {
  return `<t:${Math.floor(d.getTime() / 1000)}:F>`;
}

export function advanceText(state: RaidWindowState): string {
  if (state.phase === "skipped") {
    return [
      "**No raid weekend this week.**",
      `Base damage stays off. Reason: ${state.skipReason}`,
      "Lowering flags still scores, as always.",
    ].join("\n");
  }
  return [
    "**Raid weekend opens tomorrow.**",
    `Base damage comes on at ${stamp(state.opensAt)} and goes off at ${stamp(state.closesAt)}.`,
    "Lowering flags scores all week; the window only decides whether walls take damage.",
  ].join("\n");
}

export function openText(state: RaidWindowState): string {
  return [
    "**Raid weekend is live.** Base damage is on.",
    `It closes at ${stamp(state.closesAt)}.`,
  ].join("\n");
}

export function closeText(state: RaidWindowState): string {
  return [
    "**Raid weekend is over.** Base damage is off.",
    `The next one opens at ${stamp(state.opensAt)}.`,
  ].join("\n");
}

/**
 * ⚠️ Ops-facing, and deliberately states what the file STILL SAYS rather than what
 * was wanted. Whoever reads this at 02:00 needs to know the server's current
 * behaviour, not the intention that failed.
 */
export function failureText(boundaryAt: Date, wantedDisabled: boolean, error: string): string {
  // ⚠️ "still" is the OPPOSITE of `wantedDisabled`, not that value restated: a failed
  // flip leaves the file exactly where it was before the attempt, and a boundary flip
  // always tries to move AWAY from that prior value (open wants disableBaseDamage=false,
  // close wants disableBaseDamage=true) — so what the file "still" is, is whatever
  // `wantedDisabled` was trying to leave behind.
  return [
    "⚠️ **Raid window flip failed.**",
    `Boundary: ${boundaryAt.toISOString()}`,
    `Wanted: disableBaseDamage=${wantedDisabled}`,
    `The file was NOT changed, so base damage is still ${wantedDisabled ? "OFF" : "ON"}.`,
    `Error: ${error}`,
    "The next restart slot retries automatically. This alert fires once per boundary.",
  ].join("\n");
}
