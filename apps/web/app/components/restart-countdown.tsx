"use client";

import { useEffect, useState } from "react";
import { nextRestartAt } from "@factions/domain";
import { restartColumn, type RestartColumn } from "@/lib/timer-bar";

/**
 * The restart column's value and its draining rule.
 *
 * ⚠️ Every second, unlike `RaidCountdown`'s 30s. The two clocks are deliberately
 * different: a raid window is days long and a ticking display there only invites
 * reloading, while this one is a two-hour cycle whose last ten minutes are the
 * whole point — that is when a player decides whether to log out somewhere safe.
 *
 * ⚠️ The slot is RECOMPUTED every tick rather than counted down to an instant the
 * server picked once. Counting to a fixed target means a tab left open across a
 * restart reads 00:00 for as long as it stays open, on the one page a player is
 * most likely to leave sitting on a second monitor. The slots are pure epoch
 * arithmetic, so rolling over needs no round trip.
 *
 * ⚠️ The colour and the rule move with the value, so all three render here rather
 * than on the server. A server-painted gold that never arrives, or a rule frozen
 * at the width it had at page load, is worse than no bar at all.
 */
export function RestartCountdown({ initial, valueClass }: { initial: RestartColumn; valueClass: string }) {
  // ⚠️ Seeded from the server's own computation for the first paint; the clock
  // starts after mount, or React reports a hydration mismatch and discards the
  // markup. Same discipline as RaidCountdown, and the same reason.
  const [c, setC] = useState(initial);
  useEffect(() => {
    const tick = () => {
      const now = new Date();
      setC(restartColumn(nextRestartAt(now), now));
    };
    tick(); // after mount, so the first paint matches the server
    const id = setInterval(tick, 1000);
    return () => clearInterval(id);
  }, []);
  return (
    <>
      <span className={`flex-none ${valueClass} ${c.soon ? "text-gold" : "text-ink"}`}>{c.value}</span>
      {/* Drains right to left, mirroring the raid rule, as the canvas draws it. */}
      <div aria-hidden="true" className="absolute inset-x-0 -bottom-0.5 h-0.5">
        <div className={`ml-auto h-full ${c.soon ? "bg-gold" : "bg-rule-3"}`} style={{ width: `${(c.fill * 100).toFixed(2)}%` }} />
      </div>
    </>
  );
}
