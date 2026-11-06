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

/** The compact reasons for the monospaced block: `🔥9`, `🩹1`, `🐣 8 Nov`. The footer spells them out. */
function shortReasons(p: PriceView): string[] {
  return [
    p.recentRaids > 0 ? `🔥${p.recentRaids}` : null,
    p.hitsThisWeek > 0 ? `🩹${p.hitsThisWeek}` : null,
    p.newUntil ? `🐣 ${day(p.newUntil)}` : null,
  ].filter((r) => r !== null);
}

/**
 * The price list as a Discord code block, so tags and prices line up in columns:
 *
 *     Z2     148     🔥9 🩹1
 *     NDF    296 🟢
 *
 * Tag and price come first because they are plain text and align exactly. The emojis go last:
 * phones draw them a little wider than a letter, so anything after them can drift.
 *
 * ⚠️ A backtick in a tag would close the code block early and spill the rest of the list as
 * markdown, so it is swapped for a plain quote. Inside the block nothing else needs escaping.
 */
export function priceBlock(rows: { tag: string; price: PriceView }[]): string {
  const tags = rows.map((r) => r.tag.replaceAll("`", "'"));
  const tagWidth = Math.max(0, ...tags.map((t) => t.length));
  const payWidth = Math.max(0, ...rows.map((r) => String(r.price.payout).length));
  const lines = rows.map((r, i) => {
    // The online marker is an emoji about two columns wide, so an offline row pads with three
    // spaces (its separator plus two) to keep the reasons in one column.
    const online = r.price.online ? " 🟢" : "   ";
    const line = `${tags[i]!.padEnd(tagWidth)}  ${String(r.price.payout).padStart(payWidth)}${online}  ${shortReasons(r.price).join(" ")}`;
    return line.trimEnd();
  });
  return ["```", ...lines, "```"].join("\n");
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
  "🐣 a new clan, worth nothing until the date shown.",
].join(" ");

/** The same ordering everywhere: highest payout first, then tag. Dormant (no price) clans are left out. */
export function priceList<T extends { tag: string; price: PriceView | null }>(rows: T[]): (T & { price: PriceView })[] {
  return rows.filter((r): r is T & { price: PriceView } => r.price !== null)
    .sort((a, b) => b.price.payout - a.price.payout || a.tag.localeCompare(b.tag));
}
