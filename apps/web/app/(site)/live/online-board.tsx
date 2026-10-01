"use client";
import { useEffect, useState } from "react";
import { onlineLine, ONLINE_TITLE, ONLINE_EMPTY } from "@factions/copy";
import { visiblePoll } from "@/lib/visible-poll";
import { kicker } from "@/app/components/ui";
import { LIVE_POLL_MS } from "./live-list";
import { Rich } from "./rich";

export type OnlinePlayer = { gamertag: string; tag: string | null; connectedAt: string };

/**
 * Who is on the server now, longest-connected first (the read's order, kept).
 * Re-fetched from /api/live/online every LIVE_POLL_MS while the tab is visible;
 * each poll replaces the whole list.
 */
export function OnlineBoard({ initial }: { initial: OnlinePlayer[] }) {
  const [players, setPlayers] = useState(initial);

  useEffect(() => visiblePoll(document, async () => {
    try {
      const r = await fetch("/api/live/online", { cache: "no-store" });
      if (!r.ok) return;
      setPlayers(((await r.json()) as { players: OnlinePlayer[] }).players);
    } catch { /* a missed poll is retried in 15 s */ }
  }, LIVE_POLL_MS), []);

  if (players.length === 0) return <p className="text-ink-2">{ONLINE_EMPTY}</p>;
  return (
    <>
      <div className={kicker}>{ONLINE_TITLE(players.length)}</div>
      <ul className="mt-3 divide-y divide-rule">
        {players.map((p) => <li key={`${p.gamertag}@${p.connectedAt}`} className="py-2 text-ink-2"><Rich line={onlineLine(p)} /></li>)}
      </ul>
    </>
  );
}
