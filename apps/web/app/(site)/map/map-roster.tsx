import { useId } from "react";
import type { RosterRow } from "@/lib/map-roster";
import { ROSTER_COPY } from "@/lib/map-copy";

/**
 * The map as a list: one button a row, and a row centres the map on its
 * marker and opens it. It is the way in for a keyboard or a screen reader,
 * which cannot find a 28px chip by looking, and the quick way for anyone to
 * answer "where is Bob".
 *
 * Rendered twice (the desktop panel and the phone sheet, one of them always
 * `display: none`), so the heading id comes from `useId`, never a literal.
 *
 * `nested` is the phone sheet, which scrolls itself: a list that also scrolled
 * inside it trapped a swipe, and the legend under the list went out of reach.
 */
export function MapRoster({ rows, onGo, nested = false }: { rows: RosterRow[]; onGo: (key: string) => void; nested?: boolean }) {
  const head = useId();
  return (
    <section aria-labelledby={head} className="border-t border-rule-2">
      <h2 id={head} className="m-0 px-5 pb-1 pt-3 font-mono text-[11px] uppercase tracking-[0.18em] text-muted">{ROSTER_COPY.heading}</h2>
      {rows.length === 0 ? (
        <p className="m-0 px-5 pb-3 text-sm text-dim">{ROSTER_COPY.empty}</p>
      ) : (
        <ul className={`m-0 list-none p-0 pb-1.5 ${nested ? "" : "max-h-[40dvh] overflow-y-auto"}`}>
          {rows.map((r) => (
            <li key={r.key}>
              <button type="button" onClick={() => onGo(r.key)} className="flex min-h-[44px] w-full flex-col items-start justify-center px-5 py-1.5 text-left hover:bg-surface">
                <span className="text-sm text-ink">{r.name}</span>
                <span className="font-mono text-[11px] text-muted">{r.detail}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
