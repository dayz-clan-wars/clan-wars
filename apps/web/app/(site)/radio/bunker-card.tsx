import type { BunkerCard } from "@/lib/radio/tally";
import { kicker, linkMono } from "@/app/components/ui";

/**
 * One digit: dimmed AND dotted-underlined until two passes agree with none
 * against, so an unsettled code looks unsettled to an eye that can't tell
 * the greys apart, on a phone held up to a TV.
 */
function Digit({ value, sure }: { value: string; sure: boolean }) {
  return <span className={sure ? "text-ink" : "text-muted underline decoration-dotted decoration-2 underline-offset-[6px]"}>{value}</span>;
}

/** What's left before this card can be trusted, in a few words. */
function progress(card: BunkerCard | null, offList: boolean): string {
  if (!card) return "Not heard yet";
  const heard = card.reads === 1 ? "Heard once" : `Heard ${card.reads} times`;
  if (card.settled) return heard;
  if (offList) return heard;
  return card.reads === 1 ? `${heard} · one more pass to settle` : `${heard} · still settling`;
}

/** One bunker: its grid and key as heard so far, how often, and a way to the map once the grid is whole. */
export function BunkerCardView({ n, card }: { n: 1 | 2 | 3; card: BunkerCard | null }) {
  const digits = card?.digits ?? Array.from({ length: 10 }, () => ({ value: null, agree: 0, against: 0 }));
  const wholeGrid = card !== null && !card.grid.includes("?");
  // ⚠️ A whole grid with no bunker in it is a misread, however many passes
  // agree: none of its digits may look sure.
  const offList = wholeGrid && !card.isBunker;
  const show = (from: number, to: number) => digits.slice(from, to).map((d, i) => (
    <Digit key={from + i} value={d.value ?? "?"} sure={!offList && d.value !== null && d.agree >= 2 && d.against === 0} />
  ));
  const spaced = card ? `${card.grid.slice(0, 3)} ${card.grid.slice(3)}` : "";
  return (
    <div className={`border-2 p-4 lg:p-5 ${card?.settled ? "border-gold/60" : "border-rule-2"}`}>
      <div className="flex items-baseline justify-between gap-4">
        <div className={kicker}>Bunker {n}</div>
        {card?.settled && <div className="font-mono text-[11px] uppercase tracking-[0.18em] text-gold">Settled</div>}
      </div>
      <dl className="mt-3 grid grid-cols-[auto_1fr] items-baseline gap-x-4 gap-y-1">
        <dt className={kicker}>Grid</dt>
        <dd className="font-mono text-2xl tracking-[0.12em]">{show(0, 3)} {show(3, 6)}</dd>
        <dt className={kicker}>Key</dt>
        <dd className="font-mono text-2xl tracking-[0.12em]">{show(6, 10)}</dd>
      </dl>
      {offList && <p className="mt-3 text-sm text-ink-2">Not a bunker square, so something was misheard. Keep listening.</p>}
      <div className="mt-3 flex items-center justify-between gap-4 text-sm text-ink-2">
        <span>{progress(card, offList)}</span>
        {/* ⚠️ A new tab: the radio keeps listening, and a signed-out player's
            trip through sign-in never takes the page they were listening on. */}
        {wholeGrid && (
          <a
            className={`${linkMono} inline-flex min-h-[44px] items-center`}
            href={`/map?at=${card.grid}`}
            target="_blank"
            rel="noopener"
            aria-label={`Open grid ${spaced} on the map, in a new tab`}
          >
            Map <span aria-hidden="true">↗</span>
          </a>
        )}
      </div>
    </div>
  );
}
