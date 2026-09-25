"use client";
import { useMemo, useState } from "react";
import type { SearchEntry } from "./index";

/** What the live region says for a query `q` with `n` hits: nothing until the search starts (two characters). */
export function resultsLine(q: string, n: number): string {
  if (q.trim().length < 2) return "";
  if (n === 0) return "No results";
  return n === 1 ? "1 result" : `${n} results`;
}

/**
 * What Escape does in the search box, for query `q`: a non-empty query
 * clears first ("clear"); an already-empty query has nothing left to clear,
 * so Escape falls through to the popover's own handler ("bubble") — the
 * guide's Contents drawer closes on the second press, not the first.
 */
export function escapeAction(q: string): "clear" | "bubble" {
  return q.trim().length > 0 ? "clear" : "bubble";
}

/**
 * A guide search box: substring match over chapter, heading and hint text,
 * in the browser, over the index the layout built. Two characters to start,
 * twelve results at most, Escape clears.
 *
 * ⚠️ The count is announced through a polite live region (L7): results
 * appear under the box as you type, and without it a screen reader hears
 * nothing happen.
 */
export function GuideSearch({ index, compact = false }: { index: SearchEntry[]; compact?: boolean }) {
  const [q, setQ] = useState("");
  const hits = useMemo(() => {
    const needle = q.trim().toLowerCase();
    if (needle.length < 2) return [];
    return index.filter((e) => `${e.chapter} ${e.heading ?? ""} ${e.text} ${e.body ?? ""}`.toLowerCase().includes(needle)).slice(0, 12);
  }, [q, index]);

  return (
    <div className="relative">
      <input
        type="search" value={q} onChange={(e) => setQ(e.target.value)}
        onKeyDown={(e) => {
          if (e.key !== "Escape") return;
          if (escapeAction(q) === "clear") {
            setQ("");
            // ⚠️ Without this, the same keypress also reaches PopoverDismiss's
            // document-level Escape listener and closes the enclosing Contents
            // popover — one press did two things. A second, empty-query Escape
            // is left to bubble, which is how that popover ever closes from here.
            e.stopPropagation();
          }
        }}
        placeholder="Search the guide" aria-label="Search the guide" autoComplete="off" spellCheck={false}
        className="block min-h-[44px] w-full border-2 border-rule-3 bg-ground px-3 font-mono text-[13px] text-ink placeholder:text-muted focus:border-gold focus:outline-none"
      />
      <p role="status" aria-live="polite" className="sr-only">{resultsLine(q, hits.length)}</p>
      {q.trim().length >= 2 && (
        <ol className="m-0 mt-2 list-none border-2 border-rule-2 bg-frame p-0" aria-label="Results">
          {hits.length === 0 && <li className="px-3 py-2.5 text-sm text-ink-2">Nothing in the guide says that.</li>}
          {hits.map((h) => (
            <li key={h.href} className="border-t border-rule-2 first:border-t-0">
              <a href={h.href} className="block px-3 py-2.5 no-underline hover:bg-surface">
                <span className="block font-display text-[13px] text-ink">{h.number}. {h.chapter}{h.heading && <span className="text-gold"> › {h.heading}</span>}</span>
                {h.text && <span className="mt-0.5 block text-xs leading-relaxed text-ink-2">{h.text}</span>}
              </a>
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}
