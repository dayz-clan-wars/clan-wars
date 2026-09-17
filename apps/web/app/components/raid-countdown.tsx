"use client";

import { useEffect, useState } from "react";
import { humanizeUntil } from "@/lib/raid-strip";

/**
 * The countdown only. Everything else in the strip is server-rendered.
 *
 * Refreshes every 30s, matching the map's age labels — coarse enough that a
 * minute-level display never looks stuck and never invites a reload.
 */
export function RaidCountdown({ prefix, initial, target }: { prefix: string; initial: string; target: string }) {
  // ⚠️ Seeded from the SERVER's string, never from `new Date()` during render. A
  // clock read at render time gives the server one value and the browser another a
  // minute later, and React reports a hydration mismatch and discards the markup.
  // The first client render must reproduce the server's output exactly; the clock
  // only starts after mount.
  const [text, setText] = useState(initial);
  useEffect(() => {
    const to = new Date(target);
    const tick = () => setText(humanizeUntil(new Date(), to));
    tick(); // after mount, so the first paint matches the server
    const id = setInterval(tick, 30_000);
    return () => clearInterval(id);
  }, [target]);
  return <span>{prefix} {text}</span>;
}
