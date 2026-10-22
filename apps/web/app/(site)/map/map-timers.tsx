import type { RaidTone, TimerColumns } from "@/lib/timer-bar";
import { RaidCountdown } from "@/app/components/raid-countdown";
import { RestartCountdown } from "@/app/components/restart-countdown";

/** The raid cell's faces, as the timer bar paints them: live goes solid rust, warn puts the words in gold. */
const FACE: Record<RaidTone, { cell: string; kicker: string; label: string; value: string }> = {
  live: { cell: "bg-rust-2", kicker: "text-ground", label: "text-ground", value: "text-ground" },
  muted: { cell: "", kicker: "text-dim", label: "text-muted", value: "text-ink" },
  warn: { cell: "", kicker: "text-dim", label: "text-muted", value: "text-gold" },
};

const KICKER = "flex-none font-mono text-[11px] font-bold uppercase tracking-[0.12em]";
const VALUE = "font-mono text-[13px] font-bold tabular-nums";

/**
 * The site's raid and restart clocks, folded into the map's own chrome. The
 * map drops the strips under the top bar for the room (lib/site-strips.ts),
 * and this is what keeps the one page raiders plan from showing both clocks.
 *
 * `bar` is the desktop's bottom-left bar: two cells at its left end, each
 * closing with the bar's hairline. `row` is the phone sheet: one row, the
 * raid column taking the slack.
 *
 * ⚠️ A labelled group, NOT `role="status"`, for TimerBar's reason: the restart
 * clock moves every second, and a live region would announce every tick.
 */
export function MapTimers({ columns: { raid, restart }, variant }: { columns: TimerColumns; variant: "bar" | "row" }) {
  if (!raid && !restart) return null;
  const f = raid ? FACE[raid.tone] : null;
  const bar = variant === "bar";
  const cell = bar ? "flex min-h-[44px] items-center gap-2.5 border-r border-rule-2 px-4" : "flex min-h-[40px] min-w-0 items-center gap-2 px-4";
  return (
    <div role="group" aria-label="Raid window and server restart" className={bar ? "flex items-stretch" : "flex items-stretch border-b border-rule-2"}>
      {raid && f && (
        <div className={`${cell} ${bar ? "" : "flex-1"} ${f.cell}`}>
          <span className={`${KICKER} ${f.kicker}`}>Raid</span>
          <span className={`whitespace-nowrap font-display text-xs uppercase tracking-[0.04em] ${f.label}`}>{raid.label}</span>
          <span className={`truncate ${VALUE} ${f.value}`}>
            {/* No target: the value is words (a skip, an unconfirmed flip), never a clock — see TimerBar. */}
            {raid.target ? <RaidCountdown initial={raid.value} target={raid.target} /> : raid.value}
          </span>
        </div>
      )}
      {restart && (
        <div className={`${cell} flex-none ${!bar && raid ? "border-l border-rule-2" : ""}`}>
          <span className={`${KICKER} text-dim`}>Restart</span>
          <RestartCountdown initial={restart} valueClass={VALUE} rule={false} />
        </div>
      )}
    </div>
  );
}
