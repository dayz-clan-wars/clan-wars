import type { TimerColumns } from "@/lib/timer-bar";
import { RestartCountdown } from "@/app/components/restart-countdown";

const KICKER = "flex-none font-mono text-[11px] font-bold uppercase tracking-[0.12em]";
const VALUE = "font-mono text-[13px] font-bold tabular-nums";

/**
 * The site's restart clock, folded into the map's own chrome. The map drops the
 * strips under the top bar for the room (lib/site-strips.ts), and this is what
 * keeps the clock on the one page players plan from.
 *
 * `bar` is the desktop's bottom-left bar: one cell at its left end, closing with
 * the bar's hairline. `row` is the phone sheet: one row.
 *
 * ⚠️ A labelled group, NOT `role="status"`, for TimerBar's reason: the restart
 * clock moves every second, and a live region would announce every tick.
 */
export function MapTimers({ columns: { restart }, variant }: { columns: TimerColumns; variant: "bar" | "row" }) {
  if (!restart) return null;
  const bar = variant === "bar";
  const cell = bar ? "flex min-h-[44px] items-center gap-2.5 border-r border-rule-2 px-4" : "flex min-h-[40px] min-w-0 items-center gap-2 px-4";
  return (
    <div role="group" aria-label="Server restart" className={bar ? "flex items-stretch" : "flex items-stretch border-b border-rule-2"}>
      <div className={`${cell} flex-none`}>
        <span className={`${KICKER} text-dim`}>Restart</span>
        <RestartCountdown initial={restart} valueClass={VALUE} rule={false} />
      </div>
    </div>
  );
}
