import type { LoadView } from "@/lib/map-load";
import { MAP_LOAD_COPY } from "@/lib/map-copy";
import { btnSecondary } from "@/app/components/ui";

/**
 * What covers the map before there is one. `stale` and `ready` render
 * nothing: a map that exists is never covered, and the stale warning lives
 * with the notices (map-notices.tsx), beside the controls.
 *
 * Under Leaflet's controls (1000) and the bars (1100), so a partly built map
 * is never blocked by it.
 */
export function MapStatus({ view, onRetry }: { view: LoadView; onRetry: () => void }) {
  if (view === "loading") {
    return (
      <div className="pointer-events-none absolute inset-0 z-[950] flex items-center justify-center">
        <p role="status" className="m-0 border-2 border-rule-2 bg-frame px-4 py-3 font-mono text-[11px] uppercase tracking-[0.18em] text-muted">{MAP_LOAD_COPY.loading}</p>
      </div>
    );
  }
  if (view === "failed-first") {
    return (
      <div className="absolute inset-0 z-[950] flex items-center justify-center px-6">
        <div role="alert" className="max-w-[24rem] border-2 border-rule-3 bg-frame px-5 py-4 text-center">
          <p className="m-0 text-sm text-ink">{MAP_LOAD_COPY.failedFirst}</p>
          <button type="button" onClick={onRetry} className={`${btnSecondary} mt-3`}>{MAP_LOAD_COPY.retry}</button>
        </div>
      </div>
    );
  }
  return null;
}
