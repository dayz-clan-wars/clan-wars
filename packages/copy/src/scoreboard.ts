import { RAID_HEAT_FADE_MS, RAID_HIT_FADE_MS, RAID_OFFLINE_MULT, RAID_ONLINE_MULT } from "@factions/domain";
import { days } from "./format";

/**
 * The live raid-price list: what a raid on each clan pays right now, and why.
 * One set of sentences for #scoreboard and /scoreboard, so the two cannot drift.
 *
 * ⚠️ Reasons are COUNTS, never a relative time ("9h ago"). The post is edited only when its key
 * changes, and a relative time would force an edit every pass or go stale between them. The one
 * date is an absolute day, which does not move.
 *
 * The price shape is written out here rather than imported: this package may not import a
 * runtime value from @factions/roster (test/leaf.test.ts), and a type import is not worth the edge.
 */
export type PriceView = { payout: number; online: boolean; recentRaids: number; hitsThisWeek: number; newUntil: Date | null };

export const PRICE_TITLE = "💰 What a raid pays right now";

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;
const day = (d: Date) => d.toLocaleDateString("en-GB", { day: "numeric", month: "short", timeZone: "UTC" });

/** The reasons behind a price, in a fixed order, each only when it applies. */
export function priceReasons(p: PriceView): string[] {
  return [
    p.recentRaids > 0 ? `🔥 ${plural(p.recentRaids, "recent raid", "recent raids")}` : null,
    p.hitsThisWeek > 0 ? `🩹 hit ${plural(p.hitsThisWeek, "time", "times")} this week` : null,
    p.newUntil ? `🐣 new, counts from ${day(p.newUntil)}` : null,
  ].filter((r) => r !== null);
}

/** `Z2 · 148 · 🔥 9 recent raids`; a 🟢 follows the price when someone from the clan is online (it is already the ×1.5 price). */
export function priceRow(tag: string, p: PriceView): string {
  return [tag, p.online ? `${p.payout} 🟢` : `${p.payout}`, ...priceReasons(p)].join(" · ");
}

/** Clans that cannot be raided, on one line; null when there are none. */
export function dormantLine(tags: string[]): string | null {
  return tags.length === 0 ? null : `Can't be raided: ${tags.join(", ")}`;
}

/** Numbers come from rules.ts, so a retune changes the sentence with it. */
export const PRICE_FOOTER = [
  "A raid pays the price at the moment the flag comes down.",
  `🔥 raids in the last ${days(RAID_HEAT_FADE_MS)} push it up; 🩹 hits in the last ${days(RAID_HIT_FADE_MS)} pull it down.`,
  `🟢 someone from that clan is online, so a raid pays ×${RAID_ONLINE_MULT} (×${RAID_OFFLINE_MULT} when nobody is).`,
].join(" ");

/** The same ordering everywhere: highest payout first, then tag. Dormant (no price) clans are left out. */
export function priceList<T extends { tag: string; price: PriceView | null }>(rows: T[]): (T & { price: PriceView })[] {
  return rows.filter((r): r is T & { price: PriceView } => r.price !== null)
    .sort((a, b) => b.price.payout - a.price.payout || a.tag.localeCompare(b.tag));
}
