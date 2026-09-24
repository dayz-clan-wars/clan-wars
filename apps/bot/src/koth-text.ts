import { atRel } from "@factions/copy";
import type { KothResults } from "@factions/db";
import { KOTH_AWARD_KEY, KOTH_REMINDER_LEAD_MS, KOTH_ZONE_RADIUS_M } from "@factions/domain";
import { awardsCatalogue } from "@factions/domain/awards";
import { escapeMarkdown as esc } from "./site-links.js";

// ⚠️ A gamertag is player-controlled text landing in a public channel; escaping
// markdown here is what stops it restyling the post — the house escaper
// (site-links.ts), same one ban-announce-text.ts uses. Do not add a second escaper.
// ⚠️ The lead and the prize's length come from rules.ts and the award catalogue —
// a literal here would keep promising "30 minutes" and "a week" after either moved.
export const reminderMinutes = KOTH_REMINDER_LEAD_MS / 60_000;
const prizeDays = awardsCatalogue()[KOTH_AWARD_KEY]!.durationDays;
const prizeLength = prizeDays === 7 ? "a week" : `${prizeDays} day${prizeDays === 1 ? "" : "s"}`;
const rules = `Fresh spawns start on the hill with a KotH kit. A kill counts when the victim is within ${KOTH_ZONE_RADIUS_M} m of the centre. Most kills wins ${prizeLength} of the Plate Carrier.`;

export function scheduledText(town: string, slotAt: Date): string {
  return [`**KING OF THE HILL: ${town.toUpperCase()}**`, `Starts at the restart ${atRel(slotAt) ?? ""}.`, rules].join("\n");
}
export function reminderText(town: string, slotAt: Date): string {
  return [`**KING OF THE HILL IN ${reminderMinutes} MINUTES: ${town.toUpperCase()}**`, `Starts ${atRel(slotAt) ?? "at the next restart"}.`, rules].join("\n");
}
export function liveText(town: string): string {
  return [`**KING OF THE HILL IS LIVE: ${town.toUpperCase()}**`, rules, "It ends at the next restart."].join("\n");
}
export function resultsText(town: string, r: KothResults): string {
  if (r.top.length === 0) return `**KING OF THE HILL: ${town.toUpperCase()} — RESULTS**\nNobody scored a kill on the hill. No Plate Carrier this time.`;
  const lines = [`**KING OF THE HILL: ${town.toUpperCase()} — RESULTS**`, ...r.top.map((t, i) => `${i + 1}. ${esc(t.gamertag)} — ${t.kills}`)];
  if (r.winner) {
    lines.push(`🏆 The Plate Carrier goes to **${esc(r.winner.gamertag)}**.`);
    if (r.topKiller && r.topKiller.dayzId !== r.winner.dayzId) lines.push(`${esc(r.topKiller.gamertag)} topped the board but is not linked on Discord, so the prize passed down.`);
  } else {
    lines.push("Nobody on the board is linked on Discord, so no Plate Carrier this time.");
  }
  if (r.droppedNoPosition > 0) lines.push(`(${r.droppedNoPosition} kills had no position in the log and could not be counted.)`);
  return lines.join("\n");
}
export function cancelledText(town: string, slotAt: Date): string {
  return `**KING OF THE HILL CANCELLED: ${town.toUpperCase()}**\nThe session planned for ${atRel(slotAt) ?? "the restart"} will not run.`;
}
