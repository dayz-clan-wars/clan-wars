import type { WipeVehicle } from "@factions/domain";

const HOUR_MS = 60 * 60 * 1000;

/** UTC midnight of `d`'s calendar day, for comparing "which day is this" only. */
function utcDayStart(d: Date): number {
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
}

/**
 * "tomorrow" when the wipe is on the next UTC calendar day (the usual case — posted a
 * day ahead); otherwise the wipe is TODAY, so say so with an hour estimate instead.
 *
 * ⚠️ The posting window is [wipeAt-24h, wipeAt-1h), which includes Monday 00:00-07:00
 * UTC — a bot down all Sunday can recover and post that late. Saying "tomorrow" then
 * would misinform players a couple of hours before the wipe actually happens.
 */
function whenPhrase(wipeAt: Date, now: Date): string {
  if (utcDayStart(wipeAt) > utcDayStart(now)) return "tomorrow";
  const hoursLeft = (wipeAt.getTime() - now.getTime()) / HOUR_MS;
  // ⚠️ Never "in about 0 hours" — round, but a wipe under an hour out still gets a
  // sentence a player can act on.
  if (hoursLeft < 1) return "today, very soon";
  return `today, in about ${Math.round(hoursLeft)} hours`;
}

/**
 * The Sunday notice. Plain content, no embed — it is one short sentence of fact, and
 * the other plain-text poster (#war-log) is the house precedent for that.
 */
export function weeklyWipeAnnouncement(vehicle: WipeVehicle, wipeAt: Date, now: Date): string {
  const hh = String(wipeAt.getUTCHours()).padStart(2, "0");
  const mm = String(wipeAt.getUTCMinutes()).padStart(2, "0");
  const when = whenPhrase(wipeAt, now);
  return [
    `🚗 **Weekly vehicle wipe — ${when}, ${hh}:${mm} UTC**`,
    `This week it's **${vehicle.name}** (\`${vehicle.event}\`). Every one on the map is `
      + `cleared at the ${hh}:${mm} restart and respawns fresh a couple of hours later.`,
    `Move anything you want to keep out of them before then.`,
  ].join("\n");
}
