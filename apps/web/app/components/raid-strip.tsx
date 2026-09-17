import type { BaseDamageWindow } from "@factions/roster";
import { raidStripLine } from "@/lib/raid-strip";
import { RaidCountdown } from "./raid-countdown";

const TONE: Record<string, string> = {
  live: "text-gold",
  warn: "text-gold",
  muted: "text-muted",
};

/**
 * The raid-window status strip, in the top bar's frame beneath the server-name
 * marquee. Nothing to show renders nothing — an unreachable read is no strip,
 * never an error and never a guess.
 */
export function RaidStrip({ window: w }: { window: BaseDamageWindow | undefined }) {
  if (!w) return null;
  const line = raidStripLine(w, new Date());
  const target = w.status === "live" ? w.closesAt : w.opensAt;
  const countdownPrefix = w.status === "live" ? "closes in" : "opens in";
  return (
    <div role="status" aria-label="Raid window" className="border-b-2 border-rule-2 bg-frame">
      <div className="flex h-9 items-center gap-2 px-4 font-display text-sm uppercase tracking-[0.04em] text-muted">
        <span>{line.label}:</span>
        <span className={TONE[line.tone]}>{line.value}</span>
        <span className="text-muted">
          {w.status === "live" || w.status === "closed"
            ? <RaidCountdown prefix={countdownPrefix} target={target.toISOString()} />
            : line.detail}
        </span>
      </div>
    </div>
  );
}
