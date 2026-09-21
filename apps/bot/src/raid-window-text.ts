import type { RaidWindowState } from "@factions/domain";
import { at, atRel, rel } from "@factions/copy";

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
    `Base damage comes on at ${atRel(state.opensAt) ?? "the next restart"} and goes off at `
      + `${at(state.closesAt) ?? "the restart after"}.`,
    "Lowering flags scores all week; the window only decides whether walls take damage.",
  ].join("\n");
}

export function openText(state: RaidWindowState): string {
  return [
    "**Raid weekend is live.** Base damage is on.",
    `It closes ${rel(state.closesAt) ?? "at the scheduled restart"}.`,
  ].join("\n");
}

export function closeText(state: RaidWindowState): string {
  return [
    "**Raid weekend is over.** Base damage is off.",
    `The next one opens at ${atRel(state.opensAt) ?? "the next scheduled window"}.`,
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
  // always wants to move AWAY from that prior value (open wants disableBaseDamage=false,
  // close wants disableBaseDamage=true). disableBaseDamage=true means raiding is OFF
  // (see raid-window.ts), so failing to write wantedDisabled=false leaves the file at
  // disableBaseDamage=true — still OFF — and failing to write wantedDisabled=true
  // leaves it at disableBaseDamage=false — still ON.
  return [
    "⚠️ **Raid window flip failed.**",
    `Boundary: ${boundaryAt.toISOString()}`,
    `Wanted: disableBaseDamage=${wantedDisabled}`,
    `The file was NOT changed, so base damage is still ${wantedDisabled ? "ON" : "OFF"}.`,
    `Error: ${error}`,
    "The next restart slot retries automatically. This alert fires once per boundary.",
  ].join("\n");
}
