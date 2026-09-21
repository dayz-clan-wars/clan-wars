import type { WipeVehicle } from "@factions/domain";
import { atRel } from "@factions/copy";

/**
 * The Sunday notice. Plain content, no embed — it is one short sentence of
 * fact, and the other plain-text poster (#war-log) is the house precedent.
 *
 * ⚠️ Takes no clock. It used to compute "tomorrow" vs "today, in about N
 * hours" against `now`, which was wrong whenever the bot recovered late
 * inside the posting window. `atRel` cannot have that bug: the token is
 * the instant, and Discord does the arithmetic per reader.
 */
export function weeklyWipeAnnouncement(vehicle: WipeVehicle, wipeAt: Date): string {
  const stamp = atRel(wipeAt);
  return [
    `🚗 **Weekly vehicle wipe — ${stamp ?? "at the next restart"}**`,
    `This week it's **${vehicle.name}** (\`${vehicle.event}\`). Every one on the map is `
      + `cleared at that restart and respawns fresh a couple of hours later.`,
    `Move anything you want to keep out of them before then.`,
  ].join("\n");
}
