import type { BaseDamageWindow } from "@factions/roster";
import { nextRestartAt } from "@factions/domain";
import { raidColumn, restartColumn, type RaidColumn, type RaidTone } from "@/lib/timer-bar";
import { RaidCountdown } from "./raid-countdown";
import { RestartCountdown } from "./restart-countdown";

/** The left column's faces. `warn` is neutral on purpose — see the ⚠️ in lib/timer-bar.ts. */
const TONE: Record<RaidTone, { cell: string; kicker: string; divider: string; label: string; value: string; rule: string }> = {
  // Live: the column goes solid rust and the ink is knocked out to the page ground.
  live: { cell: "bg-rust-2", kicker: "text-ground", divider: "bg-ground/30", label: "text-ground", value: "text-ground", rule: "bg-ground" },
  muted: { cell: "bg-frame", kicker: "text-dim", divider: "bg-rule-2", label: "text-muted", value: "text-ink", rule: "bg-rule-2" },
  warn: { cell: "bg-frame", kicker: "text-dim", divider: "bg-rule-2", label: "text-muted", value: "text-gold", rule: "bg-rule-2" },
};

const KICKER = "font-mono text-[10px] font-bold uppercase tracking-[0.16em] lg:text-[11px] lg:tracking-[0.18em]";
const VALUE = "font-mono text-[15px] font-bold tabular-nums lg:text-[17px] lg:tracking-[0.02em]";
/** The hairline between a kicker and its value. The phone stacks the two, so it only appears from lg. */
const DIVIDER = "hidden w-px flex-none self-stretch lg:block";
/** Phone: kicker stacked over the value. lg: the two on one line. */
const CELL = "relative flex min-h-[54px] min-w-0 flex-col justify-center gap-[3px] py-2 lg:min-h-[56px] lg:flex-row lg:items-center lg:gap-3.5";

/**
 * The rule along the raid column's bottom edge, filling left to right.
 * `-bottom-0.5` puts it ON the bar's own 2px border, as the canvas draws it.
 * The restart rule drains the other way and lives in its client component.
 */
function Rule({ fill, className }: { fill: number; className: string }) {
  return (
    <div aria-hidden="true" className="absolute inset-x-0 -bottom-0.5 h-0.5">
      <div className={`h-full ${className}`} style={{ width: `${(fill * 100).toFixed(2)}%` }} />
    </div>
  );
}

function RaidCell({ c }: { c: RaidColumn }) {
  const t = TONE[c.tone];
  return (
    <div className={`${CELL} pl-4 pr-3 lg:pl-8 lg:pr-5 ${t.cell}`}>
      <span className={`${KICKER} flex-none ${t.kicker}`}>Raid</span>
      <span aria-hidden="true" className={`${DIVIDER} ${t.divider}`} />
      <div className="flex min-w-0 flex-wrap items-baseline gap-x-[7px] gap-y-1 lg:gap-x-2.5">
        <span className={`whitespace-nowrap font-display text-xs uppercase tracking-[0.04em] lg:text-sm ${t.label}`}>{c.label}</span>
        <span className={`whitespace-nowrap ${VALUE} ${t.value}`}>
          {/* ⚠️ No target means the value is words, not a clock — a skipped weekend or an
              unconfirmed flip. Ticking one would invent a countdown to an instant nobody knows. */}
          {c.target ? <RaidCountdown initial={c.value} target={c.target} /> : c.value}
        </span>
        {c.detail && <span className={`${KICKER} font-normal ${t.kicker}`}>{c.detail}</span>}
      </div>
      {c.fill > 0 && <Rule fill={c.fill} className={t.rule} />}
    </div>
  );
}

/** The restart column's chrome. Its value, colour and rule all move every second, so they live in the client component. */
function RestartCell({ nextAt, now, divided }: { nextAt: Date; now: Date; divided: boolean }) {
  return (
    <div className={`${CELL} items-end pl-3 pr-4 lg:justify-end lg:pl-5 lg:pr-8 ${divided ? "border-l border-rule-2" : ""}`}>
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
 * raid window on the left, the next scheduled restart on the right, each with a
 * rule along the bottom edge showing how much of its span is left.
 *
 * Both columns stay side by side on a phone; the label sits above its value
 * there rather than beside it, so neither clock truncates.
 *
 * Nothing to show renders nothing — an unreachable read is no bar, never an
 * error and never a guess. That is per column: a failed raid read with restarts
 * running leaves the restart column, full width, rather than blanking both.
 *
 * ⚠️ A labelled region, NOT `role="status"`. The restart value changes every
 * second, and a live region would have a screen reader announce every tick of it
 * for as long as the page is open. The bar is there to be read, not to interrupt.
 */
export function TimerBar({ window: w, restartsScheduled, now }: {
  window: BaseDamageWindow | undefined;
  restartsScheduled: boolean;
  /**
   * ⚠️ One clock read for every column and every countdown seed. The seeds are
   * what the client hydrates against, so they must all come from this render
   * rather than from a second `new Date()` a millisecond — or a minute — later.
   */
  now: Date;
}) {
  if (!w && !restartsScheduled) return null;
  const raid = w ? raidColumn(w, now) : null;
  const nextAt = restartsScheduled ? nextRestartAt(now) : null;
  return (
    <div role="region" aria-label="Raid window and server restart" className="border-b-2 border-rule-2 bg-frame">
      <div className={`grid ${raid && nextAt ? "grid-cols-2" : "grid-cols-1"}`}>
        {raid && <RaidCell c={raid} />}
        {nextAt && <RestartCell nextAt={nextAt} now={now} divided={raid !== null} />}
      </div>
    </div>
  );
}
