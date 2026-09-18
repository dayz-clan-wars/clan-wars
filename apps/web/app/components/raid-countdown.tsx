"use client";

import { useEffect, useState } from "react";
import { humanizeUntil } from "@/lib/timer-bar";

/**
 * The raid column's countdown value only. Its label, tone and rule are
 * server-rendered; this is the one part that has to keep moving.
 *
 * Refreshes every 30s, matching the map's age labels — a raid window is days
 * long, so a coarser clock never looks stuck and never invites a reload. The
 * restart column is the opposite case and has its own component.
 */
export function RaidCountdown({ initial, target }: { initial: string; target: string }) {
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
  return <>{text}</>;
}
