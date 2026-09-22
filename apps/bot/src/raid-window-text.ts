import type { RaidWindowState } from "@factions/domain";
import { rel } from "@factions/copy";

export function advanceText(state: RaidWindowState): string {
  if (state.phase === "skipped") {
    return [
      "**RAID WINDOW SCRUBBED**",
      `Base damage stays off this week. Reason: ${state.skipReason}`,
    ].join("\n");
  }
  return [
    "**RAID WINDOW INBOUND**",
    `Base damage on ${rel(state.opensAt) ?? "at the next restart"}, `
      + `off ${rel(state.closesAt) ?? "at the restart after"}.`,
  ].join("\n");
}

export function openText(state: RaidWindowState): string {
  return [
    "**RAID WINDOW OPEN**",
    `Base damage is on. Closes ${rel(state.closesAt) ?? "at the scheduled restart"}.`,
  ].join("\n");
}

export function closeText(state: RaidWindowState): string {
  return [
    "**RAID WINDOW CLOSED**",
    `Base damage is off. Next window ${rel(state.opensAt) ?? "at the next scheduled window"}.`,
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
