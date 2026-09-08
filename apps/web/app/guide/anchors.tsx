"use client";
import { useEffect } from "react";

/**
 * Copies a section's URL when its `#` anchor is clicked. Progressive: the
 * anchor is a real link to the id, so without this the hash still changes
 * and the address bar still shows the link — this just saves the copy.
 */
export function Anchors() {
  useEffect(() => {
    const onClick = (e: MouseEvent) => {
      const a = (e.target as HTMLElement).closest?.("a.anchor") as HTMLAnchorElement | null;
      if (!a) return;
      try { void navigator.clipboard?.writeText(a.href); } catch { /* the hash still changes */ }
    };
    document.addEventListener("click", onClick);
    return () => document.removeEventListener("click", onClick);
  }, []);
  return null;
}
