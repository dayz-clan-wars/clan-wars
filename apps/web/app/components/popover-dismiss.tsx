"use client";
import { useEffect } from "react";
import { POPOVER_GROUP, othersThan, toDismiss } from "@/lib/popover";

/**
 * Escape, a click outside, and one-at-a-time for every <details> in the
 * bar's popover group (lib/popover.ts). Mounted once, by SiteBar, so the
 * drawer, the bell and Contents all behave the same way instead of each
 * carrying its own listeners.
 */
export function PopoverDismiss() {
  useEffect(() => {
    const open = () => [...document.querySelectorAll<HTMLDetailsElement>(`details[name="${POPOVER_GROUP}"][open]`)];
    const close = (ds: HTMLDetailsElement[]) => ds.forEach((d) => d.removeAttribute("open"));
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      for (const d of open()) {
        // Hand focus back to the summary, or a keyboard user is left on a node that just vanished.
        const had = d.contains(document.activeElement);
        d.removeAttribute("open");
        if (had) d.querySelector("summary")?.focus();
      }
    };
    const onClick = (e: MouseEvent) => close(toDismiss(open(), e.target as Node));
    // ⚠️ `toggle` does not bubble, so this listens in the CAPTURE phase, which still sees it at the document.
    const onToggle = (e: Event) => {
      const d = e.target;
      if (d instanceof HTMLDetailsElement && d.open && d.getAttribute("name") === POPOVER_GROUP) close(othersThan(open(), d));
    };
    document.addEventListener("keydown", onKey);
    document.addEventListener("click", onClick);
    document.addEventListener("toggle", onToggle, true);
    return () => {
      document.removeEventListener("keydown", onKey);
      document.removeEventListener("click", onClick);
      document.removeEventListener("toggle", onToggle, true);
    };
  }, []);
  return null;
}
