import type { WipeVehicle } from "@factions/domain";
import { rel } from "@factions/copy";

/**
 * The Sunday notice. Plain content, no embed — it is one short sentence of
 * fact, and the other plain-text poster (#war-log) is the house precedent.
 *
 * ⚠️ Takes no clock. It used to compute "tomorrow" vs "today, in about N
 * hours" against `now`, which was wrong whenever the bot recovered late
 * inside the posting window. `rel` cannot have that bug: the token is
 * the instant, and Discord does the arithmetic per reader.
 *
 * ⚠️ The respawn line is not decoration. Without it the notice reads as if the
 * vehicle were being removed from the map for good, and the one thing a player
 * must do — empty it first — reads as pointless.
 *
 * ⚠️ The events.xml class (`VehicleCivilianSedan`) is deliberately NOT named here
 * any more: this channel is player-facing and the class is an operator's detail.
 * `weeklyWipeVehicle()` is where to look it up.
 */
export function weeklyWipeAnnouncement(vehicle: WipeVehicle, wipeAt: Date): string {
  return [
    `**VEHICLE WIPE: ${vehicle.name.toUpperCase()}**`,
    `Cleared ${rel(wipeAt) ?? "at the next restart"}. Fresh ones spawn a couple of `
      + `hours later. Empty them before then.`,
  ].join("\n");
}
