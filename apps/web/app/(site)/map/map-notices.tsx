import { MAP_LOAD_COPY } from "@/lib/map-copy";

/**
 * The map's notices: a pin action's result, and the stale-data warning.
 *
 * ⚠️ Neither one is rust. Rust means an obligation the player still owes the
 * server (globals.css). An out-of-date map is a fact about the network, and a
 * pin result is news. The stale box takes the control edge, rule-3.
 *
 * A pin result can be dismissed; the stale warning cannot, because it clears
 * itself on the next good refresh.
 */
export function MapNotices({ notice, stale, onDismiss, tone }: {
  notice?: string;
  stale: boolean;
  onDismiss: () => void;
  /** The ground it sits on: the desktop floats on the map (frame), the phone bar is already frame (surface). */
  tone: "frame" | "surface";
}) {
  if (!notice && !stale) return null;
  const bg = tone === "frame" ? "bg-frame" : "bg-surface";
  return (
    <div className="flex flex-col gap-2">
      {notice && (
        <div className={`flex items-start border border-rule-2 ${bg}`}>
          <p role="status" className="m-0 min-w-0 flex-1 px-3 py-2 text-sm text-ink">{notice}</p>
          <button type="button" onClick={onDismiss} aria-label="Dismiss" className="flex h-11 w-11 flex-none items-center justify-center font-mono text-sm text-muted hover:text-ink">✕</button>
        </div>
      )}
      {stale && <p role="status" className={`m-0 border border-rule-3 ${bg} px-3 py-2 text-sm text-ink`}>{MAP_LOAD_COPY.stale}</p>}
    </div>
  );
}
