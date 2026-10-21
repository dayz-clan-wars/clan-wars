"use client";
import { useId, useMemo, useState, type KeyboardEvent } from "react";
import { SEARCH_COPY } from "@/lib/map-copy";
import { gridRef } from "@/lib/map-projection";
import { searchMap, type SearchCtx, type SearchHit, type SearchTab } from "@/lib/map-search";

/** Where a pick sends the map. `reticle`: a typed coordinate gets a mark; a place or bunker is already on the map. */
export type MapSearchPick = { x: number; z: number; reticle: boolean };

export type MapSearchProps = {
  ctx: SearchCtx;
  onPick: (pick: MapSearchPick) => void;
  /** The box was emptied: the map drops the reticle with it. */
  onClear?: () => void;
  /** "panel" is the desktop box top-left; "bar" is the phone's full-width bar under the strips. */
  variant: "panel" | "bar";
  /** For render tests: the query the box starts with. */
  initial?: string;
};

/** How many names the list shows; the rest are a sharper query away. */
const SHOWN = 20;
const TABS: SearchTab[] = ["locations", "items", "models"];

/**
 * The map's search box: a GPS ref, metres, a place name or "bunker 7". Two numbers
 * offer one row, "Go to"; numbers it cannot read put the hint under the box; a
 * name lists its matches under a tab per kind. Only tabs with results are drawn,
 * so Items and Models stay out of the way until something fills them.
 */
export function MapSearch({ ctx, onPick, onClear, variant, initial = "" }: MapSearchProps) {
  const [q, setQ] = useState(initial);
  const [open, setOpen] = useState(initial.trim() !== "");
  const [tab, setTab] = useState<SearchTab>("locations");
  const [active, setActive] = useState(0);
  const id = useId();
  const result = useMemo(() => searchMap(q, ctx), [q, ctx]);
  const { coord } = result;
  const tabs = TABS.filter((t) => result.hits.some((h) => h.tab === t));
  const shownTab = tabs.includes(tab) ? tab : (tabs[0] ?? "locations");
  const hits = result.hits.filter((h) => h.tab === shownTab).slice(0, SHOWN);
  const go = coord && coord.kind !== "bad" ? coord : null;
  // One list either way: the coordinate's single row, or the names.
  const rows: { key: string; label: string; detail?: string; pick: MapSearchPick | null }[] = go
    ? [{ key: "coord", label: `${SEARCH_COPY.goTo} GPS ${gridRef(go.x, go.z, ctx.size)}`, detail: `${Math.round(go.x)}, ${Math.round(go.z)}`, pick: { x: go.x, z: go.z, reticle: true } }]
    : hits.map((h, i) => ({ key: `${i}`, label: h.label, pick: hitPick(h) }));
  const at = Math.min(active, Math.max(0, rows.length - 1));

  const pick = (p: MapSearchPick | null) => {
    if (!p) return;
    setOpen(false);
    onPick(p);
  };
  const onKey = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "ArrowDown") { e.preventDefault(); setOpen(true); setActive(Math.min(at + 1, rows.length - 1)); }
    else if (e.key === "ArrowUp") { e.preventDefault(); setActive(Math.max(at - 1, 0)); }
    else if (e.key === "Enter") { e.preventDefault(); pick(rows[at]?.pick ?? null); }
    // ⚠️ Stopped here: the layers panel closes on a window Escape, and one key must not do two things.
    else if (e.key === "Escape") { e.stopPropagation(); if (open) setOpen(false); else { setQ(""); onClear?.(); } }
  };

  const bar = variant === "bar";
  const listOpen = open && q.trim() !== "" && coord?.kind !== "bad";
  const listId = `${id}-list`;
  return (
    <div className={`relative ${bar ? "w-full" : "w-[300px]"}`}>
      <input
        type="search" role="combobox" aria-label={SEARCH_COPY.label} placeholder={SEARCH_COPY.placeholder}
        aria-expanded={listOpen} aria-controls={listId} aria-autocomplete="list"
        aria-activedescendant={listOpen && rows.length > 0 ? `${id}-${at}` : undefined}
        aria-describedby={coord?.kind === "bad" ? `${id}-hint` : undefined}
        value={q} autoComplete="off" spellCheck={false}
        onChange={(e) => { setQ(e.target.value); setOpen(true); setActive(0); if (!e.target.value.trim()) onClear?.(); }}
        onFocus={() => setOpen(true)}
        onBlur={() => setOpen(false)}
        onKeyDown={onKey}
        className="block min-h-[44px] w-full border-2 border-rule-2 bg-frame px-3 font-mono text-[13px] text-ink placeholder:text-muted focus:border-gold focus:outline-none"
      />
      {coord?.kind === "bad" && (
        <p id={`${id}-hint`} role="status" className="m-0 border-2 border-t-0 border-rule-2 bg-frame px-3 py-2 font-mono text-[11px] leading-relaxed text-muted">{coord.hint}</p>
      )}
      {listOpen && (
        // ⚠️ mousedown is held back so the input keeps focus: its blur closes the list, and a
        // click that blurred first would close the list before the row's click landed.
        <div className="absolute inset-x-0 top-full z-10 border-2 border-t-0 border-rule-2 bg-frame" onMouseDown={(e) => e.preventDefault()}>
          {!go && tabs.length > 0 && (
            <div role="tablist" aria-label={SEARCH_COPY.label} className="flex border-b border-rule-2">
              {tabs.map((t) => (
                <button key={t} type="button" role="tab" aria-selected={t === shownTab} tabIndex={-1} onClick={() => { setTab(t); setActive(0); }}
                  className={`min-h-[36px] px-3 font-mono text-[11px] uppercase tracking-[0.12em] ${t === shownTab ? "text-gold" : "text-muted hover:text-ink"}`}>{SEARCH_COPY.tabs[t]}</button>
              ))}
            </div>
          )}
          <ul id={listId} role="listbox" aria-label={SEARCH_COPY.label} className="m-0 max-h-[50dvh] list-none overflow-y-auto p-0">
            {rows.map((r, i) => (
              <li key={r.key} id={`${id}-${i}`} role="option" aria-selected={i === at} onClick={() => pick(r.pick)} onMouseEnter={() => setActive(i)}
                className={`flex min-h-[44px] cursor-pointer items-center gap-3 px-3 text-sm ${i === at ? "bg-surface text-gold" : "text-ink"}`}>
                {r.label}
                {r.detail && <span className="ml-auto font-mono text-[11px] text-muted">{r.detail}</span>}
              </li>
            ))}
          </ul>
          {rows.length === 0 && <p className="m-0 px-3 py-3 font-mono text-[11px] text-muted">{SEARCH_COPY.none}</p>}
        </div>
      )}
    </div>
  );
}

/** Only a location has a place to fly to; items and models (later work) pick differently. */
function hitPick(h: SearchHit): MapSearchPick | null {
  return h.tab === "locations" ? { x: h.x, z: h.z, reticle: false } : null;
}
