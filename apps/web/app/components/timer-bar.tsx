import { nextRestartAt } from "@factions/domain";
import { restartColumn } from "@/lib/timer-bar";
import { RestartCountdown } from "./restart-countdown";

/** ⚠️ 11px at every width: 10px failed the floor on the phone (M7). Tracking tightens on a phone instead. */
const KICKER = "font-mono text-[11px] font-bold uppercase tracking-[0.12em] lg:tracking-[0.18em]";
const VALUE = "font-mono text-[15px] font-bold tabular-nums lg:text-[17px] lg:tracking-[0.02em]";
/** The hairline between a kicker and its value. The phone stacks the two, so it only appears from lg. */
const DIVIDER = "hidden w-px flex-none self-stretch lg:block";
/** Phone: kicker stacked over the value. lg: the two on one line. */
const CELL = "relative flex min-h-[54px] min-w-0 flex-col justify-center gap-[3px] py-2 lg:min-h-[56px] lg:flex-row lg:items-center lg:gap-3.5";

/** The restart column's chrome. Its value, colour and rule all move every second, so they live in the client component. */
function RestartCell({ nextAt, now }: { nextAt: Date; now: Date }) {
  return (
    <div className={`${CELL} items-end pl-3 pr-4 lg:justify-end lg:pl-5 lg:pr-8`}>
      <span className={`${KICKER} flex-none text-dim`}>
        <span className="lg:hidden">Restart</span><span className="hidden lg:inline">Server restart</span>
      </span>
      <span aria-hidden="true" className={`${DIVIDER} bg-rule-2`} />
      <RestartCountdown initial={restartColumn(nextAt, now)} valueClass={VALUE} />
    </div>
  );
}

/**
 * The timer bar, in the top bar's frame beneath the server-name marquee: the
 * next scheduled restart, with a rule along the bottom edge showing how much of
 * the period is left. (A raid-window column sat on the left until raiding went
 * 24/7.)
 *
 * No scheduled restarts renders nothing — never an error and never a guess.
 *
 * ⚠️ A labelled region, NOT `role="status"`. The restart value changes every
 * second, and a live region would have a screen reader announce every tick of it
 * for as long as the page is open. The bar is there to be read, not to interrupt.
 */
export function TimerBar({ restartsScheduled, now }: {
  restartsScheduled: boolean;
  /**
   * ⚠️ One clock read for the column and its countdown seed. The seed is what the
   * client hydrates against, so it must come from this render rather than from a
   * second `new Date()` a millisecond — or a minute — later.
   */
  now: Date;
}) {
  if (!restartsScheduled) return null;
  return (
    <div role="region" aria-label="Server restart" className="border-b-2 border-rule-2 bg-frame">
      <div className="grid grid-cols-1">
        <RestartCell nextAt={nextRestartAt(now)} now={now} />
      </div>
    </div>
  );
}
