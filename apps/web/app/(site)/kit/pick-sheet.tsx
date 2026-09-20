"use client";

import { useEffect, useMemo, useRef } from "react";
import type { CatalogueEntry, KitSlot } from "@factions/domain";
import { SLOT_LABELS } from "@/lib/kit-copy";

/**
 * One slot's options, over the page.
 *
 * Full screen on a phone and a centred panel on desktop, which is the same
 * shape the design gives it: two hundred jackets is a page of its own on a
 * 390px screen and a dialog on a 1120px one.
 *
 * ⚠️ Picking SAVES. There is no Save button on this page any more, so every
 * tile here is a write, and the sheet closes on the way out rather than
 * waiting for the response: the toast underneath is what reports the save,
 * and holding a full-screen sheet open over a network round trip would make
 * every pick feel broken on a phone.
 */

/** "Ski Mask (Beige)" -> "Ski Mask". The catalogue's labels are all in this shape. */
const family = (label: string): string => label.split(" (")[0]!.trim();
/** "Ski Mask (Beige)" -> "Beige", and a label with no bracket unchanged. */
const short = (label: string): string => {
  const i = label.indexOf(" (");
  return i === -1 ? label : label.slice(i + 2, label.length - 1);
};

type Group = { name: string; items: CatalogueEntry[] };

/**
 * The options, grouped by family, with the family you are wearing first.
 *
 * ⚠️ Families of one are collected into a single "One of a kind" group rather
 * than left as sixty one-tile headings. The jacket slot has 58 entries across
 * a dozen families; without this the sheet is mostly rules and captions.
 */
function grouped(options: CatalogueEntry[], query: string, current: string | null): Group[] {
  const q = query.trim().toLowerCase();
  const list = options.filter((o) => !q || o.label.toLowerCase().includes(q));
  const byFamily = new Map<string, CatalogueEntry[]>();
  for (const o of list) {
    const f = family(o.label);
    const bucket = byFamily.get(f);
    if (bucket) bucket.push(o);
    else byFamily.set(f, [o]);
  }
  const multi: Group[] = [];
  const singles: CatalogueEntry[] = [];
  for (const [name, items] of byFamily) {
    if (items.length > 1) multi.push({ name, items });
    else singles.push(items[0]!);
  }
  if (singles.length) multi.push({ name: "One of a kind", items: singles });
  const wearing = multi.findIndex((g) => g.items.some((o) => o.className === current));
  if (wearing > 0) multi.unshift(multi.splice(wearing, 1)[0]!);
  return multi;
}

export function PickSheet({ slot, options, current, query, onQuery, onChoose, onClose }: {
  slot: KitSlot;
  options: CatalogueEntry[];
  current: string | null;
  query: string;
  onQuery: (q: string) => void;
  /** An empty string clears the slot. */
  onChoose: (className: string, label: string | null) => void;
  onClose: () => void;
}) {
  const search = useRef<HTMLInputElement>(null);
  const groups = useMemo(() => grouped(options, query, current), [options, query, current]);

  // ⚠️ Escape and the body lock are set up together and torn down together.
  // A sheet that swallowed the page's scroll and then closed by a route change
  // would leave the body locked with nothing on screen to unlock it.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    const previous = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    window.addEventListener("keydown", onKey);
    search.current?.focus();
    return () => {
      window.removeEventListener("keydown", onKey);
      document.body.style.overflow = previous;
    };
  }, [onClose]);

  return (
    <div
      className="fixed inset-0 z-[1400] bg-ground lg:flex lg:items-center lg:justify-center lg:bg-ground/75 lg:p-10"
      // The backdrop is a click target on desktop only; on a phone the sheet
      // fills the screen and there is nothing behind it to click.
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="sheet-title"
        className="cw-sheet flex h-full flex-col bg-ground lg:h-auto lg:max-h-full lg:w-full lg:max-w-[760px] lg:border-2 lg:border-rule-2"
      >
        <div className="flex-none border-b-2 border-rule-2 bg-frame">
          <div className="flex h-bar items-center justify-between gap-3 pl-4 pr-2">
            <h2 id="sheet-title" className="m-0 font-display text-[15px] uppercase tracking-[0.02em] text-ink">{SLOT_LABELS[slot]}</h2>
            <button type="button" onClick={onClose}
              className="min-h-[44px] min-w-[44px] font-mono text-[11px] uppercase tracking-[0.14em] text-gold">
              Done
            </button>
          </div>
          <div className="px-4 pb-3">
            <input
              ref={search}
              type="search"
              value={query}
              onChange={(e) => onQuery(e.target.value)}
              placeholder={`Search ${SLOT_LABELS[slot].toLowerCase()}`}
              aria-label={`Search ${SLOT_LABELS[slot].toLowerCase()}`}
              autoComplete="off"
              spellCheck={false}
              className="block min-h-[46px] w-full border-2 border-rule-3 bg-ground px-3.5 font-mono text-sm text-ink placeholder:text-muted focus:border-gold focus:outline-none"
            />
          </div>
        </div>

        <div className="flex-1 overflow-y-auto px-4 pb-6">
          <button type="button" aria-pressed={current === null} onClick={() => onChoose("", null)}
            className={`mt-3.5 flex w-full items-center gap-3 bg-frame p-2.5 ${current === null ? "border-2 border-gold" : "border border-rule-2"}`}>
            <span className="flex h-11 w-11 flex-none items-center justify-center border border-dashed border-rule-3 text-base text-muted">&ndash;</span>
            <span className="text-left">
              <span className="block text-sm text-ink">Nothing</span>
              <span className="mt-0.5 block text-xs text-dim">Leave this slot empty</span>
            </span>
          </button>

          {groups.map((g) => (
            <div key={g.name} className="mt-5">
              <div className="flex items-center gap-2.5">
                <span className="whitespace-nowrap font-mono text-[10px] uppercase tracking-[0.18em] text-muted">{g.name}</span>
                <span className="h-px flex-1 bg-rule-2" />
                <span className="font-mono text-[10px] text-dim">{g.items.length}</span>
              </div>
              <div className="mt-2.5 grid grid-cols-3 gap-2 lg:grid-cols-5">
                {g.items.map((o) => {
                  const on = current === o.className;
                  return (
                    <button key={o.className} type="button" aria-pressed={on}
                      onClick={() => onChoose(o.className, o.label)}
                      className={`flex cursor-pointer flex-col gap-1.5 bg-frame p-2 transition-colors ${on ? "border-2 border-gold" : "border border-rule-2 hover:border-rule-3"}`}>
                      {o.image
                        ? <img src={`/${o.image}`} alt="" className="h-14 w-full object-contain" />
                        : <span className="flex h-14 w-full items-center justify-center border border-dashed border-rule-2 text-[10px] uppercase tracking-wide text-dim">No art</span>}
                      <span className={`text-center text-[11px] leading-tight ${on ? "text-gold" : "text-ink-2"}`}>
                        {g.name === "One of a kind" ? o.label : short(o.label)}
                      </span>
                    </button>
                  );
                })}
              </div>
            </div>
          ))}

          {groups.length === 0 && <p className="mt-7 text-center text-sm text-dim">Nothing matches that.</p>}
        </div>
      </div>
    </div>
  );
}
