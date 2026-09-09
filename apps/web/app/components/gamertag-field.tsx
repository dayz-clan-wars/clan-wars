"use client";
import { useEffect, useId, useRef, useState } from "react";
import { field } from "./ui";

/**
 * A gamertag box with autocomplete, for every place one is typed: the player
 * search (`scope="seen"`), invites and guest passes (`scope="linked"`). Lives
 * inside an ordinary form as a client island: the value rides the form's
 * own submit under `name`, so the pages stay server-rendered.
 *
 * Suggestions come from /api/players/suggest as the user types (debounced,
 * the previous request aborted). Picking one only fills the box — the form
 * still submits whatever is typed, and the write re-resolves it. Arrow keys
 * move through the list, Enter takes the highlighted name (and only then is
 * kept from submitting), Escape closes it.
 */
export function GamertagField({
  scope, name, id, placeholder = "Gamertag", required, maxLength, defaultValue = "", className = "", autoFocus,
  "aria-label": ariaLabel, "aria-describedby": describedBy, "aria-invalid": ariaInvalid,
}: {
  scope: "seen" | "linked"; name: string; id?: string; placeholder?: string; required?: boolean; maxLength?: number; defaultValue?: string;
  className?: string; autoFocus?: boolean; "aria-label"?: string; "aria-describedby"?: string; "aria-invalid"?: true;
}) {
  const [value, setValue] = useState(defaultValue);
  const [matches, setMatches] = useState<string[]>([]);
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(-1);
  const listId = useId();
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const inflight = useRef<AbortController | null>(null);

  useEffect(() => {
    if (timer.current) clearTimeout(timer.current);
    inflight.current?.abort();
    const q = value.trim();
    if (!q) { setMatches([]); setActive(-1); return; }
    timer.current = setTimeout(async () => {
      const ctl = new AbortController();
      inflight.current = ctl;
      try {
        const res = await fetch(`/api/players/suggest?scope=${scope}&q=${encodeURIComponent(q)}`, { cache: "no-store", signal: ctl.signal });
        if (!res.ok) return;
        const { matches: found } = (await res.json()) as { matches: string[] };
        // A list that is exactly what was typed is no help; hide it.
        setMatches(found.length === 1 && found[0]!.toLowerCase() === q.toLowerCase() ? [] : found);
        setActive(-1);
      } catch { /* aborted by a newer keystroke, or offline: keep what is shown */ }
    }, 150);
    return () => { if (timer.current) clearTimeout(timer.current); };
  }, [value, scope]);

  const pick = (g: string) => { setValue(g); setMatches([]); setOpen(false); setActive(-1); };
  const shown = open && matches.length > 0;

  return (
    <div className="relative min-w-0 flex-1">
      <input
        id={id} name={name} value={value} placeholder={placeholder} required={required} maxLength={maxLength} autoFocus={autoFocus}
        className={`${field} ${className}`} autoComplete="off" spellCheck={false}
        role="combobox" aria-expanded={shown} aria-controls={listId} aria-autocomplete="list"
        aria-activedescendant={shown && active >= 0 ? `${listId}-${active}` : undefined}
        aria-label={ariaLabel} aria-describedby={describedBy} aria-invalid={ariaInvalid}
        onChange={(e) => { setValue(e.target.value); setOpen(true); }}
        onFocus={() => setOpen(true)}
        onBlur={() => setOpen(false)}
        onKeyDown={(e) => {
          if (!shown) { if (e.key === "ArrowDown" && matches.length > 0) { setOpen(true); e.preventDefault(); } return; }
          if (e.key === "ArrowDown") { setActive((i) => (i + 1) % matches.length); e.preventDefault(); }
          else if (e.key === "ArrowUp") { setActive((i) => (i <= 0 ? matches.length - 1 : i - 1)); e.preventDefault(); }
          else if (e.key === "Enter" && active >= 0) { pick(matches[active]!); e.preventDefault(); }
          else if (e.key === "Escape") { setOpen(false); }
        }}
      />
      {shown && (
        <ul id={listId} role="listbox" aria-label="Gamertags" className="absolute left-0 right-0 top-full z-20 mt-0.5 border-2 border-rule-2 bg-frame shadow-[0_12px_32px_rgba(0,0,0,.45)]">
          {matches.map((g, i) => (
            // ⚠️ mousedown, not click: the input's blur closes the list before a click would land.
            <li key={g} id={`${listId}-${i}`} role="option" aria-selected={i === active}
              className={`flex min-h-[44px] cursor-pointer items-center px-4 font-mono text-sm text-ink hover:bg-surface ${i === active ? "bg-surface" : ""}`}
              onMouseDown={(e) => { e.preventDefault(); pick(g); }} onMouseEnter={() => setActive(i)}>
              {g}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
