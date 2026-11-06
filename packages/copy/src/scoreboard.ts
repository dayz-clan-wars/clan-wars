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
    p.hitsThisWeek > 0 ? `🩹 raided ${plural(p.hitsThisWeek, "time", "times")} this week` : null,
    p.newUntil ? `🐣 new, counts from ${day(p.newUntil)}` : null,
  ].filter((r) => r !== null);
}

/** `Z2 · 148 · 🔥 9 recent raids`; a 🟢 follows the price when someone from the clan is online (it is already the ×1.5 price). */
export function priceRow(tag: string, p: PriceView): string {
  return [tag, p.online ? `${p.payout} 🟢` : `${p.payout}`, ...priceReasons(p)].join(" · ");
}

/**
 * The price list as a Discord code block, so tags and prices line up in columns:
 *
 *     NDF    114 🟢
 *     Z2     148
 *
 * ⚠️ Only tag, price and a trailing 🟢. Phones wrap a long code-block line instead of scrolling,
 * and draw an emoji wider than a letter, so anything after one drifts. The reasons go under the
 * block as plain sentences (`priceReasonLines`), which wrap cleanly.
 *
 * ⚠️ A backtick in a tag would close the code block early and spill the rest of the list as
 * markdown, so it is swapped for a plain quote. Inside the block nothing else needs escaping.
 */
export function priceBlock(rows: { tag: string; price: PriceView }[]): string {
  const tags = rows.map((r) => r.tag.replaceAll("`", "'"));
  const tagWidth = Math.max(0, ...tags.map((t) => t.length));
  const payWidth = Math.max(0, ...rows.map((r) => String(r.price.payout).length));
  const lines = rows.map((r, i) =>
    `${tags[i]!.padEnd(tagWidth)}  ${String(r.price.payout).padStart(payWidth)}${r.price.online ? " 🟢" : ""}`);
  return ["```", ...lines, "```"].join("\n");
}

/**
 * The reasons behind the prices, one plain line per reason, naming the clans it applies to:
 *
 *     🩹 **Raided this week:** OUT 3 times, COCK 2, Z2 1
 *     🔥 **Raiding lately:** Z2 9, COCK 4
 *     🐣 **New:** FRESH counts from 8 Nov
 *
 * Biggest count first, then tag. The unit is spelled out on the first entry only. A line with no
 * clans is left out.
 *
 * ⚠️ Tags here are markdown, not code: the caller passes them already escaped.
 */
export function priceReasonLines(rows: { tag: string; price: PriceView }[]): string[] {
  const ranked = (count: (p: PriceView) => number) => rows.filter((r) => count(r.price) > 0)
    .sort((a, b) => count(b.price) - count(a.price) || a.tag.localeCompare(b.tag))
    .map((r) => ({ tag: r.tag, n: count(r.price) }));
  const raided = ranked((p) => p.hitsThisWeek)
    .map((r, i) => (i === 0 ? `${r.tag} ${plural(r.n, "time", "times")}` : `${r.tag} ${r.n}`));
  const raiding = ranked((p) => p.recentRaids).map((r) => `${r.tag} ${r.n}`);
  const fresh = rows.filter((r) => r.price.newUntil !== null)
    .sort((a, b) => a.price.newUntil!.getTime() - b.price.newUntil!.getTime() || a.tag.localeCompare(b.tag))
    .map((r, i) => `${r.tag} ${i === 0 ? "counts from" : "from"} ${day(r.price.newUntil!)}`);
  return [
    raided.length > 0 ? `🩹 **Raided this week:** ${raided.join(", ")}` : null,
    raiding.length > 0 ? `🔥 **Raiding lately:** ${raiding.join(", ")}` : null,
    fresh.length > 0 ? `🐣 **New:** ${fresh.join(", ")}` : null,
  ].filter((l) => l !== null);
}

/** Clans that cannot be raided, on one line; null when there are none. */
export function dormantLine(tags: string[]): string | null {
  return tags.length === 0 ? null : `Can't be raided: ${tags.join(", ")}`;
}

/** Numbers come from rules.ts, so a retune changes the sentence with it. */
export const PRICE_FOOTER = [
  "A raid pays the price at the moment the flag comes down.",
  `🔥 raids in the last ${days(RAID_HEAT_FADE_MS)} push it up; 🩹 being raided in the last ${days(RAID_HIT_FADE_MS)} pulls it down.`,
  `🟢 someone from that clan is online, so a raid pays ×${RAID_ONLINE_MULT} (×${RAID_OFFLINE_MULT} when nobody is).`,
  "🐣 a new clan, worth nothing until the date shown.",
].join(" ");

/** The same ordering everywhere: highest payout first, then tag. Dormant (no price) clans are left out. */
export function priceList<T extends { tag: string; price: PriceView | null }>(rows: T[]): (T & { price: PriceView })[] {
  return rows.filter((r): r is T & { price: PriceView } => r.price !== null)
    .sort((a, b) => b.price.payout - a.price.payout || a.tag.localeCompare(b.tag));
}
