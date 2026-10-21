import { RULER_COPY } from "@/lib/map-copy";
import { rulerSummary, type RulerPoint } from "@/lib/map-ruler";

export type MapRulerProps = {
  on: boolean;
  points: readonly RulerPoint[];
  onToggle: () => void;
  /** Ends the measurement: the points go, and the ruler turns off. */
  onClear: () => void;
  /** "panel" sits beside the desktop sprocket; "bar" beside the phone search box. */
  variant: "panel" | "bar";
};

/** A ruler's tick marks, in currentColor. */
function RulerMark({ size = 20 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 28 28" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="square" aria-hidden="true">
      <path d="M3 20L20 3l5 5L8 25z" />
      <path d="M8 15l2 2M11 12l3 3M14 9l2 2M17 6l3 3" />
    </svg>
  );
}

/**
 * The ruler's button, and while it is on, what it has measured and Clear. The
 * summary is the same text drawn beside the last point on the map, said here too
 * so a screen reader hears it (`role="status"`).
 */
export function MapRuler({ on, points, onToggle, onClear, variant }: MapRulerProps) {
  const bar = variant === "bar";
  const box = `flex h-11 w-11 flex-none items-center justify-center border-2 ${bar ? "" : "bg-frame"}`;
  return (
    <>
      {on && !bar && (
        <span role="status" className="flex min-h-[44px] items-center border-2 border-rule-2 bg-frame px-3 font-mono text-[11px] text-ink">{rulerSummary(points)}</span>
      )}
      {on && bar && <span role="status" className="sr-only">{rulerSummary(points)}</span>}
      {on && (
        <button type="button" onClick={onClear}
          className={`flex min-h-[44px] flex-none items-center border-2 px-3 font-display text-xs uppercase tracking-[0.06em] text-ink hover:text-gold ${bar ? "border-rule-3" : "border-rule-2 bg-frame"}`}>{RULER_COPY.clear}</button>
      )}
      <button type="button" onClick={onToggle} aria-pressed={on} title={RULER_COPY.label}
        className={`${box} ${on ? "border-gold text-gold" : `${bar ? "border-rule-3" : "border-rule-2"} text-ink hover:text-gold`}`}>
        <RulerMark size={bar ? 18 : 20} />
        <span className="sr-only">{RULER_COPY.label}</span>
      </button>
    </>
  );
}
