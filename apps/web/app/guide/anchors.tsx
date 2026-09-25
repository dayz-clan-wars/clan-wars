"use client";
import { useEffect, useState } from "react";

/** What the live region says after a copy. */
export const ANCHOR_COPIED = "Link copied";

/**
 * Copies a section's URL when its `#` anchor is clicked. Progressive: the
 * anchor is a real link to the id, so without this the hash still changes
 * and the address bar still shows the link — this just saves the copy.
 *
 * ⚠️ The copy is ANNOUNCED through a polite live region (L4). A silent copy
 * leaves a screen-reader user, and anyone else, guessing whether it happened.
 * The region is cleared first so a second copy is announced again.
 */
export function Anchors() {
  const [said, setSaid] = useState("");
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const onClick = (e: MouseEvent) => {
      const a = (e.target as HTMLElement).closest?.("a.anchor") as HTMLAnchorElement | null;
      if (!a || !navigator.clipboard) return;
      navigator.clipboard.writeText(a.href).then(() => {
        setSaid("");
        clearTimeout(timer);
        timer = setTimeout(() => setSaid(ANCHOR_COPIED), 50);
      }, () => { /* the hash still changes */ });
    };
    document.addEventListener("click", onClick);
    return () => { document.removeEventListener("click", onClick); clearTimeout(timer); };
  }, []);
  return <p role="status" aria-live="polite" className="sr-only">{said}</p>;
}
