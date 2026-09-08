"use client";
import { useMemo, useState } from "react";
import type { SearchEntry } from "./index";

/**
 * A guide search box: substring match over chapter, heading and hint text,
 * in the browser, over the index the layout built. Two characters to start,
 * twelve results at most, Escape clears.
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
        type="search" value={q} onChange={(e) => setQ(e.target.value)} onKeyDown={(e) => { if (e.key === "Escape") setQ(""); }}
        placeholder="Search the guide" aria-label="Search the guide" autoComplete="off" spellCheck={false}
        className="block min-h-[44px] w-full border-2 border-rule-3 bg-ground px-3 font-mono text-[13px] text-ink placeholder:text-muted focus:border-gold focus:outline-none"
      />
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
