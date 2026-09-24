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
 */
export function MapRoster({ rows, onGo }: { rows: RosterRow[]; onGo: (key: string) => void }) {
  const head = useId();
  return (
    <section aria-labelledby={head} className="border-t border-rule-2">
      <h2 id={head} className="m-0 px-5 pb-1 pt-3 font-mono text-[11px] uppercase tracking-[0.18em] text-muted">{ROSTER_COPY.heading}</h2>
      {rows.length === 0 ? (
        <p className="m-0 px-5 pb-3 text-sm text-dim">{ROSTER_COPY.empty}</p>
      ) : (
        <ul className="m-0 max-h-[40dvh] list-none overflow-y-auto p-0 pb-1.5">
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
