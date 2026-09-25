import { atRel } from "@factions/copy";
import type { KothResults } from "@factions/db";
import { KOTH_REMINDER_LEAD_MS, KOTH_ZONE_RADIUS_M } from "@factions/domain";
import { awardsCatalogue } from "@factions/domain/awards";
import { escapeMarkdown as esc } from "./site-links.js";

// ⚠️ A gamertag is player-controlled text landing in a public channel; escaping
// markdown here is what stops it restyling the post — the house escaper
// (site-links.ts), same one ban-announce-text.ts uses. Do not add a second escaper.
// ⚠️ The lead and the prize's length come from rules.ts and the award catalogue —
// a literal here would keep promising "30 minutes" and "a week" after either moved.
export const reminderMinutes = KOTH_REMINDER_LEAD_MS / 60_000;

/** The session's prize as the posts name it. Null is "no prize", chosen at `/koth schedule`. */
export type KothPrize = { label: string; durationDays: number | null } | null;

/**
 * ⚠️ A key the catalogue no longer has still renders as a prize (by its key, with
 * no length) — the players were promised one, and scoring alerts ops to grant it
 * by hand. Rendering it as "no prize" would quietly withdraw the promise.
 */
export function kothPrize(awardKey: string | null): KothPrize {
  if (awardKey === null) return null;
  const def = awardsCatalogue()[awardKey];
  return def ? { label: def.label, durationDays: def.durationDays } : { label: awardKey, durationDays: null };
}

function prizeLine(prize: KothPrize): string {
  if (!prize) return "No prize this time, just bragging rights.";
  const d = prize.durationDays;
  if (d === null) return `Most kills wins the ${prize.label}.`;
  return `Most kills wins ${d === 7 ? "a week" : `${d} day${d === 1 ? "" : "s"}`} of the ${prize.label}.`;
}
const rules = (prize: KothPrize) =>
  `Fresh spawns start on the hill with a KotH kit. A kill counts when the victim is within ${KOTH_ZONE_RADIUS_M} m of the centre. ${prizeLine(prize)}`;

export function scheduledText(town: string, slotAt: Date, prize: KothPrize): string {
  return [`**KING OF THE HILL: ${town.toUpperCase()}**`, `Starts at the restart ${atRel(slotAt) ?? ""}.`, rules(prize)].join("\n");
}
export function reminderText(town: string, slotAt: Date, prize: KothPrize): string {
  return [`**KING OF THE HILL IN ${reminderMinutes} MINUTES: ${town.toUpperCase()}**`, `Starts ${atRel(slotAt) ?? "at the next restart"}.`, rules(prize)].join("\n");
}
export function liveText(town: string, prize: KothPrize): string {
  return [`**KING OF THE HILL IS LIVE: ${town.toUpperCase()}**`, rules(prize), "It ends at the next restart."].join("\n");
}
/**
 * `withheld`: the session had a prize but scoring could not grant it (the award
 * left the catalogue) — the winner is still named, and told an admin will sort it.
 */
export function resultsText(town: string, r: KothResults, prize: KothPrize, withheld = false): string {
  const head = `**KING OF THE HILL: ${town.toUpperCase()} — RESULTS**`;
  if (r.top.length === 0) return `${head}\nNobody scored a kill on the hill.${prize ? ` No ${prize.label} this time.` : ""}`;
  const lines = [head, ...r.top.map((t, i) => `${i + 1}. ${esc(t.gamertag)} — ${t.kills}`)];
  if (r.winner && (!prize || withheld)) {
    lines.push(`🏆 **${esc(r.winner.gamertag)}** is King of the Hill.`);
    if (prize) lines.push(`The ${prize.label} could not be granted automatically; an admin has been told.`);
  } else if (r.winner && prize) {
    lines.push(`🏆 The ${prize.label} goes to **${esc(r.winner.gamertag)}**.`);
    if (r.topKiller && r.topKiller.dayzId !== r.winner.dayzId) lines.push(`${esc(r.topKiller.gamertag)} topped the board but is not linked on Discord, so the prize passed down.`);
  } else {
    lines.push(`Nobody on the board is linked on Discord, so no ${prize?.label ?? "prize"} this time.`);
  }
  if (r.droppedNoPosition > 0) lines.push(`(${r.droppedNoPosition} kills had no position in the log and could not be counted.)`);
  return lines.join("\n");
}
export function cancelledText(town: string, slotAt: Date): string {
  return `**KING OF THE HILL CANCELLED: ${town.toUpperCase()}**\nThe session planned for ${atRel(slotAt) ?? "the restart"} will not run.`;
}

export const hhmm = (d: Date) => `${d.toISOString().slice(11, 16)} UTC`;

export type VoteView = { town: string; slotAt: Date; closesAt: Date; floor: number; starter: string };
export type Tally = { yes: number; no: number };
const tallyLine = (t: Tally, floor: number) => `Yes ${t.yes} · No ${t.no} · ${t.yes + t.no} of ${floor} votes cast`;

/**
 * The public vote message (spec §6.2). Re-rendered every tick by koth-vote-tick.ts
 * and written only when it differs from `tally_text`.
 * ⚠️ `closed` replaces the deadline line — a closed vote that still says "can vote
 * until" invites presses that will all be refused.
 */
export function voteMessage(v: VoteView, t: Tally, closed?: string): string {
  const who = closed ?? `Linked players who were in game when this opened can vote until **${hhmm(v.closesAt)}**.`;
  return [
    `**King of the Hill vote.** ${esc(v.starter)} wants the **${hhmm(v.slotAt)}** restart to be King of the Hill at **${v.town}**.`,
    `${who} It needs **${v.floor}** votes and two-thirds Yes. No prize, just the hill.`,
    "",
    tallyLine(t, v.floor),
  ].join("\n");
}

/** A passed vote's post IS the event's announcement (and its reminder: it closes at T−30). */
export function votePassedText(town: string, slotAt: Date, t: Tally): string {
  return [`The vote passed (Yes ${t.yes} · No ${t.no}).`, scheduledText(town, slotAt, null)].join("\n");
}

export function voteFailedText(town: string, t: Tally, floor: number, reason: "turnout" | "majority"): string {
  const why = reason === "turnout"
    ? `only ${t.yes + t.no} of the ${floor} votes it needed were cast`
    : `Yes ${t.yes} · No ${t.no} is short of two-thirds`;
  return `The King of the Hill vote for ${town} failed: ${why}.`;
}

export function voteVoidText(town: string, why: string): string {
  return `The King of the Hill vote for ${town} did not go ahead: ${why}.`;
}
