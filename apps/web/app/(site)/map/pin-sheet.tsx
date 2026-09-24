import { useEffect, useId, useRef } from "react";
import { PIN_ICONS, PIN_NOTE_MAX } from "@factions/domain";
import { gridRef } from "@/lib/map-projection";
import { PIN_FOLLOW, PIN_ICON_LABELS, PIN_SHEET_COPY } from "@/lib/map-copy";
import { pinGlyph, type Palette } from "@/lib/map-icons";
import type { PinDraft } from "@/lib/map-pin";

/**
 * The pin sheet: the form that drops a pin at `draft`.
 *
 * Keyboard and screen reader:
 * - focus moves to the first icon on open (the sheet replaces the bars, so
 *   focus left behind was on an element that no longer existed)
 * - Escape cancels
 * - the form is named for its grid square
 * - the note has a real label, where before it had a placeholder that vanished
 *   on the first keystroke
 * Returning focus on close is map-view.tsx's job, because the button to return
 * to is one of the bars' own.
 *
 * ⚠️ The metres ride hidden inputs only, exactly as before. Every visible
 * word is a grid ref (the map's one rule, map-draw.ts).
 */
export function PinSheet({ draft, pal, onCancel, insetRef }: {
  draft: PinDraft;
  pal: Palette;
  onCancel: () => void;
  /** map-view.tsx's `insetBy`: a full-width sheet on a phone lifts the map's bottom edge, as the bar does. */
  insetRef: (el: HTMLElement | null) => void;
}) {
  const first = useRef<HTMLInputElement>(null);
  const noteId = useId();
  const grid = gridRef(draft.x, draft.z);

  useEffect(() => { first.current?.focus(); }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") { e.preventDefault(); onCancel(); }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onCancel]);

  return (
    <form
      ref={insetRef} method="post" action="/api/map/pin" aria-label={`Drop a pin at grid ${grid}`}
      // ⚠️ The bottom padding clears the home indicator, as the phone bar's does; without it the Drop and Cancel buttons sat under it.
      className="absolute inset-x-0 bottom-0 z-[1100] max-h-[70dvh] overflow-y-auto border-t-2 border-rule-2 bg-frame p-4 pb-[calc(1rem+env(safe-area-inset-bottom))] lg:inset-x-auto lg:bottom-6 lg:left-6 lg:w-[360px] lg:border-2 lg:pb-4"
    >
      <input type="hidden" name="x" value={draft.x} />
      <input type="hidden" name="z" value={draft.z} />
      <p className="m-0 font-display text-[13px] uppercase tracking-[0.06em] text-ink"><span className="mr-3 text-gold">Pin</span>{grid}</p>
      {draft.follow && <p className="mt-1 font-mono text-[11px] text-muted">{PIN_FOLLOW}</p>}
      <fieldset className="mt-3 grid grid-cols-3 gap-2">
        <legend className="sr-only">{PIN_SHEET_COPY.icon}</legend>
        {PIN_ICONS.map((icon, i) => (
          <label key={icon} className="flex min-h-[44px] cursor-pointer items-center gap-2 border-2 border-rule-3 px-2.5 text-[13px] text-ink has-[:checked]:border-gold has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-gold">
            <input ref={i === 0 ? first : undefined} type="radio" name="icon" value={icon} defaultChecked={i === 0} className="sr-only" />
            <span aria-hidden="true" className="flex flex-none" dangerouslySetInnerHTML={{ __html: pinGlyph(pal, icon, 22) }} />
            {PIN_ICON_LABELS[icon]}
          </label>
        ))}
      </fieldset>
      <label htmlFor={noteId} className="mt-3 block font-mono text-[11px] uppercase tracking-[0.18em] text-muted">
        {PIN_SHEET_COPY.note} <span className="normal-case tracking-normal">({PIN_SHEET_COPY.noteHint})</span>
      </label>
      <textarea
        id={noteId} name="note" maxLength={PIN_NOTE_MAX} rows={2}
        className="mt-1 w-full border-2 border-rule-3 bg-ground p-2.5 font-mono text-sm text-ink focus:border-gold focus:outline-none"
      />
      <div className="mt-3 grid grid-cols-2 gap-2">
        <button type="submit" className="flex min-h-[48px] items-center justify-center bg-gold font-display text-xs uppercase tracking-[0.06em] text-ground hover:bg-gold-hover">{PIN_SHEET_COPY.drop}</button>
        <button type="button" onClick={onCancel} className="flex min-h-[48px] items-center justify-center border-2 border-rule-2 font-display text-xs uppercase tracking-[0.06em] text-ink">{PIN_SHEET_COPY.cancel}</button>
      </div>
    </form>
  );
}
