"use client";

import { useEffect, useState } from "react";
import { humanizeUntil } from "@/lib/raid-strip";

/**
 * The countdown only. Everything else in the strip is server-rendered.
 *
 * Refreshes every 30s, matching the map's age labels — coarse enough that a
 * minute-level display never looks stuck and never invites a reload.
 */
export function RaidCountdown({ prefix, target }: { prefix: string; target: string }) {
  const to = new Date(target);
  const [text, setText] = useState(() => humanizeUntil(new Date(), to));
  useEffect(() => {
    const id = setInterval(() => setText(humanizeUntil(new Date(), to)), 30_000);
    return () => clearInterval(id);
  }, [target]);
  return <span>{prefix} {text}</span>;
}
