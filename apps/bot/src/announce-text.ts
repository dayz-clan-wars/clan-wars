import type { WipeVehicle } from "@factions/domain";

/**
 * The Sunday notice. Plain content, no embed — it is one short sentence of fact, and
 * the other plain-text poster (#war-log) is the house precedent for that.
 */
export function weeklyWipeAnnouncement(vehicle: WipeVehicle, wipeAt: Date): string {
  const hh = String(wipeAt.getUTCHours()).padStart(2, "0");
  const mm = String(wipeAt.getUTCMinutes()).padStart(2, "0");
  return [
    `🚗 **Weekly vehicle wipe — tomorrow, ${hh}:${mm} UTC**`,
    `This week it's **${vehicle.name}** (\`${vehicle.event}\`). Every one on the map is `
      + `cleared at the ${hh}:${mm} restart and respawns fresh a couple of hours later.`,
    `Move anything you want to keep out of them before then.`,
  ].join("\n");
}
