import type { ScoreboardRow } from "@factions/roster";
import { PRICE_TITLE, PRICE_FOOTER, priceRow, dormantLine, priceList } from "@/lib/scoring-copy";
import { Panel } from "./ui";

/**
 * What a raid on each clan pays right now: the same list, order and sentences as the #scoreboard
 * post's first embed, because both render the roster's `price` through @factions/copy. Keep them matching.
 */
export function RaidPrices({ rows }: { rows: ScoreboardRow[] }) {
  const list = priceList(rows);
  const dormant = dormantLine(rows.filter((r) => r.price === null).map((r) => r.tag));
  if (list.length === 0 && !dormant) return null;
  return (
    <section aria-labelledby="raid-prices" className="mb-6">
      <h2 id="raid-prices" className="mb-3 font-display text-xl text-ink">{PRICE_TITLE}</h2>
      <Panel>
        <ul className="divide-y divide-rule-2">
          {list.map((r) => (
            <li key={r.tag} className="px-5 py-3 font-mono text-sm tabular-nums text-ink-2">{priceRow(r.tag, r.price)}</li>
          ))}
        </ul>
        {dormant && <p className="border-t border-rule-2 px-5 py-3 font-mono text-sm text-muted">{dormant}</p>}
      </Panel>
      <p className="mt-3 font-mono text-[11px] leading-relaxed text-muted">{PRICE_FOOTER}</p>
    </section>
  );
}
